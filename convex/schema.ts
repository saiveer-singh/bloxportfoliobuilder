import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const projectValidator = v.object({
  name: v.string(),
  summary: v.string(),
  stack: v.array(v.string()),
  impact: v.string(),
  imageUrl: v.optional(v.string()),
  gameUrl: v.optional(v.string()),
});

const sectionBlockValidator = v.object({
  title: v.string(),
  body: v.string(),
});

const themeValidator = v.object({
  bg: v.string(),
  bgSurface: v.string(),
  ink: v.string(),
  accent: v.string(),
  fontBody: v.string(),
  fontDisplay: v.string(),
  radius: v.string(),
});

export default defineSchema({
  users: defineTable({
    username: v.string(),
    usernameLower: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    createdAt: v.number(),
  }).index("by_usernameLower", ["usernameLower"]),

  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_userId", ["userId"]),

  portfolios: defineTable({
    userId: v.id("users"),
    robloxUsername: v.string(),
    primaryRole: v.string(),
    signatureStyle: v.string(),
    notableProjects: v.string(),
    skillFocus: v.string(),
    targetAudience: v.string(),
    customPrompt: v.optional(v.string()),
    headline: v.string(),
    elevatorPitch: v.string(),
    about: v.string(),
    skills: v.array(v.string()),
    highlightedProjects: v.array(projectValidator),
    sectionBlocks: v.array(sectionBlockValidator),
    theme: v.optional(themeValidator),
    cta: v.string(),
    publicSlug: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_userId_createdAt", ["userId", "createdAt"])
    .index("by_publicSlug", ["publicSlug"]),

  streams: defineTable({
    userId: v.id("users"),
    purpose: v.string(), // e.g. "generate", "revise"
    text: v.string(), // Accumulated text or JSON
    state: v.string(), // "streaming" | "completed" | "error"
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  bargainSessions: defineTable({
    userId: v.id("users"),
    mood: v.number(),
    messages: v.array(
      v.object({
        role: v.string(),
        text: v.string(),
      }),
    ),
    discountUnlocked: v.boolean(),
    messageCount: v.number(),
    createdAt: v.number(),
  }).index("by_userId", ["userId"]),

  payments: defineTable({
    userId: v.id("users"),
    stripeSessionId: v.string(),
    amount: v.number(),
    status: v.string(), // "pending" | "completed"
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_stripeSessionId", ["stripeSessionId"]),
});
