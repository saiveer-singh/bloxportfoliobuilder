import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, query, internalMutation, internalQuery } from "./_generated/server.js";
import { requireUserByToken, type AuthenticatedUser } from "./auth";

const currentUserByToken = makeFunctionReference<
  "query",
  { token: string },
  AuthenticatedUser | null
>("auth:currentUser");

// Check if user has an active payment
export const checkPaymentStatus = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .filter((q) => q.eq(q.field("status"), "completed"))
      .first();
    return !!payment;
  },
});

// Create a Stripe Checkout session (uses Stripe REST API directly)
export const createCheckoutSession = action({
  args: {
    token: v.string(),
    amount: v.number(), // 899 or 499 (cents)
    returnUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(currentUserByToken, { token: args.token });
    if (!user) throw new Error("Unauthorized");

    if (args.amount !== 899 && args.amount !== 499) {
      throw new Error("Invalid amount.");
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!stripeKey) {
      throw new Error(
        "Stripe is not configured. Set STRIPE_SECRET_KEY in your Convex environment variables.",
      );
    }

    const productName =
      args.amount === 499
        ? "Bloxfolio Builder Access (Bargain Deal)"
        : "Bloxfolio Builder Access";

    const returnUrlClean = args.returnUrl.replace(/[?#].*$/, "");

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", `${returnUrlClean}?payment=success&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${returnUrlClean}?payment=cancel`);
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][product_data][name]", productName);
    params.set("line_items[0][price_data][unit_amount]", String(args.amount));
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[userId]", String(user._id));
    params.set("metadata[amount]", String(args.amount));
    params.set("client_reference_id", String(user._id));

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Stripe checkout error:", response.status, error);
      throw new Error("Failed to create checkout session. Check Stripe configuration.");
    }

    const session = await response.json();
    return { url: session.url };
  },
});

// Internal: record a completed payment (called by webhook)
export const recordPayment = internalMutation({
  args: {
    userId: v.id("users"),
    stripeSessionId: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    // Check if already recorded
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_stripeSessionId", (q) => q.eq("stripeSessionId", args.stripeSessionId))
      .first();
    if (existing) return;

    // Look up the user to verify they exist
    const user = await ctx.db.get(args.userId);
    if (!user) {
      console.error("Payment webhook: user not found:", args.userId);
      return;
    }

    await ctx.db.insert("payments", {
      userId: user._id,
      stripeSessionId: args.stripeSessionId,
      amount: args.amount,
      status: "completed",
      createdAt: Date.now(),
    });
  },
});

// Internal: look up payment by Stripe session ID
export const getPaymentByStripeSession = internalQuery({
  args: { stripeSessionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_stripeSessionId", (q) => q.eq("stripeSessionId", args.stripeSessionId))
      .first();
  },
});
