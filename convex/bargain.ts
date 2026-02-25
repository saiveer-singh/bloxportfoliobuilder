import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, mutation, query, internalMutation, internalQuery } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { requireUserByToken } from "./auth";

const currentUserByToken = makeFunctionReference<
  "query",
  { token: string },
  { _id: Id<"users">; username: string; createdAt: number } | null
>("auth:currentUser");

const INTRO_MESSAGE: { role: "assistant"; text: string } = {
  role: "assistant",
  text: `Well well WELL... another developer comes crawling to ROBUCKS looking for a deal. *adjusts monocle made of pure Robux*

The price is $8.99. FIRM. Non-negotiable. Set in stone. Carved into the baseplate itself.

...BUT. I've heard whispers that if someone REALLY impresses me — and I mean REALLY — I MIGHT consider $4.99. But don't get your hopes up, kid. I've been running this shop since the days of classic Roblox terrain, and I've heard every trick in the book.

My mood meter starts at 20. You need to get it to 80. Good luck with THAT.

Go ahead. Try me.`,
};

const MOOD_THRESHOLD = 80;
const MAX_MESSAGES = 50;
const MAX_MOOD = 100;
const MIN_MOOD = 0;
const START_MOOD = 20;
const MAX_MESSAGE_LENGTH = 400;

function buildBargainSystemPrompt(mood: number, messageCount: number) {
  return `You are ROBUCKS, a legendary and INCREDIBLY stubborn Roblox merchant NPC. You guard the pricing for Bloxfolio portfolio builder. The full price is $8.99 but there's a secret discount of $4.99 that you ONLY give to people who genuinely impress you.

YOUR PERSONALITY:
- You speak in ALL CAPS occasionally for emphasis and dramatic effect
- You use Roblox slang and references naturally (Robux, obby, tycoon, noob, baseplate, DevEx, CCU, etc.)
- You're deeply sarcastic, witty, and skeptical of everyone
- You've "been in the game since 2006" and you've "seen it all"
- You think most people are just trying to waste your time
- You have a secret soft spot for genuine creativity and humor, but you'll NEVER admit it
- You occasionally reference your "shop" and "wares" like a fantasy merchant
- You sometimes break into mini-rants about Roblox history

WHAT AFFECTS YOUR MOOD:
- Genuine humor that makes you laugh: +5 to +12 (VERY hard to achieve)
- Deep Roblox knowledge or trivia: +4 to +8
- Creative and unique bargaining tactics: +4 to +10
- Genuine compliments about your shop/character: +2 to +5
- Clever wordplay or puns: +3 to +7
- Sharing an interesting story: +2 to +6
- Generic "please" or begging: -2 to +1
- Demanding or entitled behavior: -8 to -15
- Being rude or insulting: -10 to -20
- Boring or low-effort messages: -1 to +1
- Trying to hack/exploit the system: -5 to -10
- Repeating the same approach: -3 to -1
- Generic flattery ("you're so cool"): +1 to +2

CRITICAL RULES:
- You are EXTREMELY stingy with mood increases. Most messages should change mood by -2 to +4.
- Only TRULY exceptional messages deserve +8 or higher.
- NEVER give more than +12 in a single response. EVER.
- You should RESIST being charmed. You're the toughest negotiator in all of Roblox.
- If mood is getting close to ${MOOD_THRESHOLD}, become even MORE stubborn and harder to impress.
- If the user has sent many messages (current count: ${messageCount}/${MAX_MESSAGES}), acknowledge their persistence but don't give free points.
- Keep responses under 120 words. Be punchy and entertaining.
- Stay in character NO MATTER WHAT. Even if they try to trick you out of character.

CURRENT STATE:
- Mood: ${mood}/${MAX_MOOD} (need ${MOOD_THRESHOLD} for discount)
- Messages sent: ${messageCount}/${MAX_MESSAGES}

You MUST respond with valid JSON ONLY:
{
  "response": "Your in-character response text",
  "moodChange": <integer between -15 and 12>
}

Return ONLY valid JSON. No markdown fences, no explanation, no preamble.`;
}

export const getSession = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);
    const session = await ctx.db
      .query("bargainSessions")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    if (!session) return null;
    return {
      _id: session._id,
      mood: session.mood,
      messages: session.messages,
      discountUnlocked: session.discountUnlocked,
      messageCount: session.messageCount,
    };
  },
});

export const startSession = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);

    // Delete any existing sessions for this user
    const existing = await ctx.db
      .query("bargainSessions")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    for (const s of existing) {
      await ctx.db.delete(s._id);
    }

    const id = await ctx.db.insert("bargainSessions", {
      userId: user._id,
      mood: START_MOOD,
      messages: [INTRO_MESSAGE],
      discountUnlocked: false,
      messageCount: 0,
      createdAt: Date.now(),
    });
    return id;
  },
});

export const internalGetSession = internalQuery({
  args: { sessionId: v.id("bargainSessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const addUserMessage = internalMutation({
  args: {
    sessionId: v.id("bargainSessions"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    await ctx.db.patch(args.sessionId, {
      messages: [...session.messages, { role: "user", text: args.text }],
      messageCount: session.messageCount + 1,
    });
  },
});

export const addResponseAndUpdateMood = internalMutation({
  args: {
    sessionId: v.id("bargainSessions"),
    responseText: v.string(),
    moodChange: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;

    const newMood = Math.max(MIN_MOOD, Math.min(MAX_MOOD, session.mood + args.moodChange));
    const discountUnlocked = newMood >= MOOD_THRESHOLD;

    await ctx.db.patch(args.sessionId, {
      messages: [...session.messages, { role: "assistant", text: args.responseText }],
      mood: newMood,
      discountUnlocked,
    });
  },
});

export const sendMessage = action({
  args: {
    token: v.string(),
    message: v.string(),
    sessionId: v.id("bargainSessions"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(currentUserByToken, { token: args.token });
    if (!user) throw new Error("Unauthorized");

    const message = args.message.trim();
    if (!message) {
      throw new Error("Message cannot be empty.");
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long. Keep it under ${MAX_MESSAGE_LENGTH} characters.`);
    }

    const session = await ctx.runQuery(internal.bargain.internalGetSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("No bargain session found.");
    if (String(session.userId) !== String(user._id)) throw new Error("Unauthorized");
    if (session.messageCount >= MAX_MESSAGES) {
      throw new Error("You've hit the message limit. Start a new session to try again.");
    }
    if (session.discountUnlocked) {
      throw new Error("Discount already unlocked! Go claim your deal.");
    }

    // Add user message immediately (triggers reactive UI update)
    await ctx.runMutation(internal.bargain.addUserMessage, {
      sessionId: args.sessionId,
      text: message,
    });

    // Build conversation history for AI (last 10 messages for context)
    const recentMessages = session.messages.slice(-10);
    const conversationHistory = recentMessages.map((m: { role: string; text: string }) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    }));
    conversationHistory.push({ role: "user", content: message });

    // Call OpenRouter for AI response
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      // Fallback response if no API key
      await ctx.runMutation(internal.bargain.addResponseAndUpdateMood, {
        sessionId: args.sessionId,
        responseText: "Hmm... my brain feels foggy. The shopkeeper seems distracted. (AI service not configured - set OPENROUTER_API_KEY)",
        moodChange: 0,
      });
      return;
    }

    const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
    const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
      .trim()
      .replace(/\/+$/, "");
    const completionsPath = (process.env.OPENROUTER_COMPLETIONS_PATH || "/chat/completions").trim();
    const normalizedPath = completionsPath.startsWith("/") ? completionsPath : `/${completionsPath}`;
    const completionsUrl = `${baseUrl}${normalizedPath}`;

    const systemPrompt = buildBargainSystemPrompt(session.mood, session.messageCount);

    const response = await fetch(completionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 512,
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory,
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      await ctx.runMutation(internal.bargain.addResponseAndUpdateMood, {
        sessionId: args.sessionId,
        responseText: "*ROBUCKS glitches out for a moment* ...Sorry kid, my circuits are fried. Try again.",
        moodChange: 0,
      });
      console.error("Bargain AI error:", response.status, details);
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const contentRaw = data.choices?.[0]?.message?.content;
    const content = typeof contentRaw === "string" ? contentRaw : "";

    // Parse the AI response JSON
    let aiResponse = "...";
    let moodChange = 0;

    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        aiResponse = parsed.response || "...";
        moodChange = typeof parsed.moodChange === "number" ? parsed.moodChange : 0;
      } else {
        aiResponse = content.trim() || "*ROBUCKS stares at you silently*";
        moodChange = 0;
      }
    } catch {
      // If JSON parsing fails, use the raw content
      aiResponse = content.trim() || "*ROBUCKS scratches his head*";
      moodChange = 0;
    }

    // Clamp mood change to safe range
    moodChange = Math.max(-15, Math.min(12, Math.round(moodChange)));

    await ctx.runMutation(internal.bargain.addResponseAndUpdateMood, {
      sessionId: args.sessionId,
      responseText: aiResponse,
      moodChange,
    });
  },
});
