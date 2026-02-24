import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, mutation, query, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { requireUserByToken } from "./auth";

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

const inputValidator = v.object({
  robloxUsername: v.string(),
  primaryRole: v.string(),
  signatureStyle: v.string(),
  notableProjects: v.string(),
  skillFocus: v.string(),
  targetAudience: v.string(),
  customPrompt: v.optional(v.string()),
  streamId: v.optional(v.id("streams")),
});

const tokenValidator = v.object({
  token: v.string(),
});

const generatedValidator = v.object({
  headline: v.string(),
  elevatorPitch: v.string(),
  about: v.string(),
  skills: v.array(v.string()),
  highlightedProjects: v.array(projectValidator),
  sectionBlocks: v.array(sectionBlockValidator),
  theme: themeValidator,
  cta: v.string(),
});

const currentUserByToken = makeFunctionReference<
  "query",
  { token: string },
  { _id: string; username: string; createdAt: number } | null
>("auth:currentUser");

type GeneratedPortfolio = {
  headline: string;
  elevatorPitch: string;
  about: string;
  skills: string[];
  highlightedProjects: Array<{
    name: string;
    summary: string;
    stack: string[];
    impact: string;
    imageUrl?: string;
    gameUrl?: string;
  }>;
  sectionBlocks: Array<{ title: string; body: string }>;
  theme: {
    bg: string;
    bgSurface: string;
    ink: string;
    accent: string;
    fontBody: string;
    fontDisplay: string;
    radius: string;
  };
  cta: string;
};

type BuilderInput = {
  robloxUsername: string;
  primaryRole: string;
  signatureStyle: string;
  notableProjects: string;
  skillFocus: string;
  targetAudience: string;
};

function collectBalancedJsonObjects(rawContent: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < rawContent.length; i += 1) {
    const char = rawContent[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = i;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        objects.push(rawContent.slice(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }

  return objects;
}

function extractModelContent(messageContent: unknown): string | null {
  if (typeof messageContent === "string") {
    const trimmed = messageContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!Array.isArray(messageContent)) {
    return null;
  }

  const merged = messageContent
    .flatMap((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return [];
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : [];
    })
    .join("\n")
    .trim();

  return merged.length > 0 ? merged : null;
}

function parseModelJson(rawContent: string): unknown {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    candidates.push(trimmed);

    // Also try a version with trailing commas stripped (common LLM mistake)
    const noTrailingCommas = trimmed.replace(/,\s*([\]}])/g, "$1");
    if (noTrailingCommas !== trimmed && !seen.has(noTrailingCommas)) {
      seen.add(noTrailingCommas);
      candidates.push(noTrailingCommas);
    }
  };

  pushCandidate(rawContent);

  // 1. Try markdown code blocks
  for (const match of rawContent.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) {
      pushCandidate(match[1]);
      for (const object of collectBalancedJsonObjects(match[1])) {
        pushCandidate(object);
      }
    }
  }

  // 2. Try the outermost curly braces in the entire text
  const firstBrace = rawContent.indexOf("{");
  const lastBrace = rawContent.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    pushCandidate(rawContent.slice(firstBrace, lastBrace + 1));
  }

  // 3. Try finding all balanced objects
  for (const object of collectBalancedJsonObjects(rawContent)) {
    pushCandidate(object);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore parse failures for noisy wrapper text and continue scanning candidates.
    }
  }

  throw new Error(`OpenRouter response did not include a valid JSON object. Output snippet: ${rawContent.slice(0, 500)}`);
}

function normalizeGeneratedPayload(raw: unknown): GeneratedPortfolio {
  const data = (raw ?? {}) as Partial<GeneratedPortfolio>;
  const highlightedProjects = Array.isArray(data.highlightedProjects)
    ? data.highlightedProjects
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const project = item as {
          name?: string;
          summary?: string;
          stack?: string[];
          impact?: string;
          imageUrl?: string;
          gameUrl?: string;
        };
        return {
          name: project.name?.trim() || "Roblox Project",
          summary: project.summary?.trim() || "Project summary pending.",
          stack:
            Array.isArray(project.stack) && project.stack.length > 0
              ? project.stack.map((token) => token.trim()).filter(Boolean)
              : ["LuaU", "Roblox Studio"],
          impact: project.impact?.trim() || "Impact details pending.",
          imageUrl: project.imageUrl?.trim() || undefined,
          gameUrl: project.gameUrl?.trim() || undefined,
        };
      })
    : [];

  const sectionBlocks = Array.isArray(data.sectionBlocks)
    ? data.sectionBlocks
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const section = item as { title?: string; body?: string };
        return {
          title: section.title?.trim() || "Section",
          body: section.body?.trim() || "Section details pending.",
        };
      })
    : [];

  return {
    headline: data.headline?.trim() || "Roblox Developer Portfolio",
    elevatorPitch:
      data.elevatorPitch?.trim() ||
      "I design and ship Roblox experiences that scale engagement.",
    about:
      data.about?.trim() ||
      "Roblox-focused developer with a bias for gameplay systems and measurable growth.",
    skills:
      Array.isArray(data.skills) && data.skills.length > 0
        ? data.skills.map((skill) => skill.trim()).filter(Boolean)
        : ["LuaU", "Game Systems", "Live Ops"],
    highlightedProjects:
      highlightedProjects.length > 0
        ? highlightedProjects
        : [
          {
            name: "Project Showcase",
            summary: "A standout Roblox build with strong retention metrics.",
            stack: ["LuaU", "Roblox Studio"],
            impact: "Demonstrates delivery and design depth.",
          },
        ],
    sectionBlocks:
      sectionBlocks.length > 0
        ? sectionBlocks
        : [
          {
            title: "Build Philosophy",
            body: "I combine solid architecture with player-first iteration loops.",
          },
        ],
    theme:
      data.theme && typeof data.theme === "object"
        ? {
          bg: data.theme.bg || "#050505",
          bgSurface: data.theme.bgSurface || "#0a0a0c",
          ink: data.theme.ink || "#f4f4f5",
          accent: data.theme.accent || "#ccff00",
          fontBody: data.theme.fontBody || "Outfit",
          fontDisplay: data.theme.fontDisplay || "Syne",
          radius: data.theme.radius || "0px",
        }
        : {
          bg: "#050505",
          bgSurface: "#0a0a0c",
          ink: "#f4f4f5",
          accent: "#ccff00",
          fontBody: "Outfit",
          fontDisplay: "Syne",
          radius: "0px",
        },
    cta:
      data.cta?.trim() ||
      "Open to partnerships with Roblox studios shipping ambitious experiences.",
  };
}

async function runOpenRouterCompletion(
  ctx: any,
  streamId: string | undefined,
  args: {
    model: string;
    apiKey: string;
    completionsUrl: string;
    systemPrompt: string;
    userPrompt: string;
  },
) {
  const response = await fetch(args.completionsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      top_p: 0.95,
      temperature: 0.8,
      max_tokens: 8192,
      stream: true,
      include_reasoning: true,
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    const detailsLower = details.toLowerCase();

    if (streamId) {
      await ctx.runMutation(internal.portfolio.appendStream, {
        streamId: streamId as any,
        textChunk: `\n\n[Error from AI Provider: ${response.status}]`,
        isDone: false,
        isError: true,
      });
    }

    if (
      response.status === 400 &&
      (detailsLower.includes("api_key_invalid") ||
        detailsLower.includes("api key not valid"))
    ) {
      throw new Error(
        `OpenRouter API key was rejected at ${args.completionsUrl}. Confirm the key is active and has access to ${args.model}. Provider said: ${details}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `OpenRouter API auth failed (${response.status}) at ${args.completionsUrl}. Confirm OPENROUTER_API_KEY and OPENROUTER_MODEL are valid in .env.local. Provider said: ${details}`,
      );
    }
    if (response.status === 429) {
      const retryDelayMatch = details.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i);
      const retryDelay =
        retryDelayMatch?.[1] != null ? Number.parseFloat(retryDelayMatch[1]) : null;
      const quotaFailure =
        detailsLower.includes("quota") || detailsLower.includes("resource_exhausted");
      if (quotaFailure) {
        throw new Error(
          `OpenRouter quota exceeded for model '${args.model}' at ${args.completionsUrl}. ${retryDelay ? `Retry in about ${Math.ceil(retryDelay)}s.` : ""}`,
        );
      }
      if (retryDelay != null) {
        throw new Error(
          `OpenRouter API returned rate-limited response (${response.status}) at ${args.completionsUrl}. Retry in about ${Math.ceil(retryDelay)}s. Provider said: ${details}`,
        );
      }
    }
    if (response.status === 503) {
      throw new Error(
        `OpenRouter endpoint unavailable (${response.status}) at ${args.completionsUrl}: ${details}`,
      );
    }
    throw new Error(
      `OpenRouter API error (${response.status}) at ${args.completionsUrl}: ${details}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No readable stream available from OpenRouter");

  const decoder = new TextDecoder("utf-8");
  let fullContent = "";
  let buffer = "";

  let lastMutationTime = Date.now();
  let pendingAppend = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line || line === "data: [DONE]") continue;

      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta;

          let chunkText = "";
          if (delta?.reasoning) {
            chunkText += delta.reasoning;
          }
          if (delta?.content) {
            chunkText += delta.content;
          }

          if (chunkText) {
            fullContent += chunkText;
            pendingAppend += chunkText;

            // Batch mutations every 200ms to avoid overwhelming the DB
            if (streamId && Date.now() - lastMutationTime > 200) {
              await ctx.runMutation(internal.portfolio.appendStream, {
                streamId: streamId as any,
                textChunk: pendingAppend,
                isDone: false,
                isError: false,
              });
              pendingAppend = "";
              lastMutationTime = Date.now();
            }
          }
        } catch (e) {
          // ignore parse errors for partial lines or fast streaming
        }
      }
    }
  }

  if (streamId && pendingAppend) {
    await ctx.runMutation(internal.portfolio.appendStream, {
      streamId: streamId as any,
      textChunk: pendingAppend,
      isDone: false,
      isError: false,
    });
  }

  if (streamId) {
    await ctx.runMutation(internal.portfolio.appendStream, {
      streamId: streamId as any,
      textChunk: "",
      isDone: true,
      isError: false,
    });
  }

  const parsed = parseModelJson(fullContent);
  return normalizeGeneratedPayload(parsed);
}

function buildSystemPrompt() {
  return [
    "You are an elite Roblox portfolio strategist and conversion copywriter with deep expertise in the Roblox ecosystem.",
    "",
    "You understand:",
    "- Roblox Studio, LuaU/Luau, Rojo, Wally, Knit, ProfileService, DataStore2, ReplicatedStorage patterns",
    "- Game economies: Robux monetization, gamepasses, devproducts, premium payouts, DevEx revenue",
    "- Player metrics: DAU, CCU, session length, D1/D7/D30 retention, ARPDAU, ARPPU, conversion funnels",
    "- Game genres: tycoons, obbies, simulators, RPGs, PvP arenas, social hangouts, horror, racing, roleplay",
    "- Studio operations: team roles (scripter, builder, UI artist, animator, VFX), publisher partnerships, UGC programs",
    "- Technical skills: networking/remotes, physics, UI/UX (Roact/React-lua), animation systems, data persistence, anti-cheat, matchmaking",
    "",
    "Your goal: Position this developer as uniquely hireable with concrete, Roblox-specific proof signals.",
    "Every sentence should increase perceived credibility and urgency to hire.",
    "",
    "Rules:",
    "- NO generic tech/startup jargon (\"synergy\", \"leverage\", \"drive innovation\")",
    "- NO empty adjectives (\"passionate\", \"dedicated\", \"experienced\")",
    "- Use Roblox-specific terminology naturally",
    "- Reference actual metrics, systems, and concrete outcomes",
    "- Write like a top-tier career strategist who lives inside the Roblox ecosystem",
    "- Be specific, measurable, and defensible",
    "- Vary sentence structure — mix short punchy statements with longer analytical ones",
    "- CRITICAL: If the user provides custom instructions, YOU MUST OBEY THEM STRICTLY.",
    "- IF THE USER ASKS FOR A JOKE, SPECIFIC THEME, OR ANYTHING UNUSUAL, DO IT EXACTLY AS REQUESTED.",
    "- YOU ARE ALSO A LEAD DESIGNER. You must produce a cohesive, premium 'theme' consisting of dark/light modes, vibrant accents, and beautiful Google Font pairings.",
  ].join("\n");
}

function buildGenerateUserPrompt(args: BuilderInput & { customPrompt?: string }) {
  const customBlock = args.customPrompt?.trim()
    ? `\n\nCRITICAL CUSTOM INSTRUCTIONS FOR THIS GENERATION:\n================================\n${args.customPrompt.trim()}\n================================\nYOU MUST STRICTLY FOLLOW THE ABOVE INSTRUCTIONS ABOVE ALL OTHER RULES.`
    : "";

  return `Create a complete portfolio copy pack for this Roblox developer. Return valid JSON only.

Developer Profile:
- Roblox Username: ${args.robloxUsername}
- Primary Role: ${args.primaryRole}
- Signature Style: ${args.signatureStyle}
- Notable Projects: ${args.notableProjects}
- Skill Focus: ${args.skillFocus}
- Target Audience: ${args.targetAudience}${customBlock}

Required JSON shape:
{
  "headline": "string",
  "elevatorPitch": "string",
  "about": "string",
  "skills": ["string"],
  "highlightedProjects": [
    { 
      "name": "string", 
      "summary": "string", 
      "stack": ["string"], 
      "impact": "string",
      "imageUrl": "optional string (extract if present)",
      "gameUrl": "optional string (extract if present)"
    }
  ],
  "sectionBlocks": [
    { "title": "string", "body": "string" }
  ],
  "theme": {
    "bg": "string (hex code, e.g. #050505)",
    "bgSurface": "string (hex code slightly lighter than bg, e.g. #0a0a0c)",
    "ink": "string (text color, e.g. #f4f4f5)",
    "accent": "string (vibrant contrast color like #ccff00, #ff0055, #00ffcc)",
    "fontBody": "string (Google Font exact name, e.g. 'Inter', 'Outfit', 'Space Grotesk')",
    "fontDisplay": "string (Google Font exact name, e.g. 'Syne', 'Playfair Display', 'Clash Display')",
    "radius": "string (e.g. '0px' for brutalist, '12px' for soft, '9999px' for pill)"
  },
  "cta": "string"
}

Quality standards (follow precisely):
- headline: One killer value proposition, 8-12 words. Lead with what makes them uniquely valuable. No fluff.
- elevatorPitch: 2 tight paragraphs. First paragraph: biggest outcome/achievement. Second: what they uniquely bring to a team. Use specific Roblox context.
- about: 2 paragraphs. First: what they build and why it matters in the Roblox ecosystem. Second: their technical philosophy and how they ship. Reference specific systems or approaches.
- skills: Exactly 8 items. Each should be specific to their niche, NOT generic. Bad: "Programming", "Game Design". Good: "Combat Systems Architecture", "Retention-First Economy Design", "LuaU Performance Optimization"
- highlightedProjects: Exactly 3 projects. Each needs: specific project name, 2-3 sentence summary of what it is, tech stack used (LuaU, specific frameworks/tools), and ONE quantified impact statement (use defensible estimates like "5K+ peak CCU", "40% retention uplift", "2M+ visits", "shipped in 6 weeks"). CRITICAL: If the user provides any image links (e.g. imgur, png) or game links (e.g. roblox) in their notable projects list, extract them precisely into the 'imageUrl' and 'gameUrl' fields.
- sectionBlocks: Exactly 3 sections with distinct titles. Ideas: "Build Philosophy", "Technical Arsenal", "Studio Fit", "How I Ship", "What Sets Me Apart". Each body should be 2-3 sentences with proof-laden, action-oriented content.
- theme: You MUST select stunning, modern, harmonious colors and exact Google Font names. Ensure high contrast between 'bg' and 'ink'. The 'accent' should POP. Match the vibe of the generated copy.
- cta: ONE direct sentence inviting studios/founders to connect. Include a specific next step (DM, portfolio review, collab call).

Return ONLY valid JSON. No markdown fences, no explanation, no preamble.`;
}

export const generatePortfolioCopy = action({
  args: {
    ...tokenValidator.fields,
    ...inputValidator.fields,
  },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (token.length === 0) {
      throw new Error("Unauthorized");
    }

    const activeUser = await ctx.runQuery(currentUserByToken, { token });
    if (!activeUser) {
      throw new Error("Unauthorized");
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing OPENROUTER_API_KEY in process env. Set it in .env.local.",
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.length < 10) {
      throw new Error(
        "Invalid OPENROUTER_API_KEY format. Confirm you copied a valid OpenRouter key from the OpenRouter dashboard.",
      );
    }

    const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
    const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
      .trim()
      .replace(/\/+$/, "");
    const completionsPath = (process.env.OPENROUTER_COMPLETIONS_PATH || "/chat/completions").trim();
    const normalizedPath = completionsPath.startsWith("/")
      ? completionsPath
      : `/${completionsPath}`;
    const completionsUrl = `${baseUrl}${normalizedPath}`;
    return await runOpenRouterCompletion(
      ctx,
      args.streamId,
      {
        model,
        apiKey,
        completionsUrl,
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildGenerateUserPrompt(args),
      }
    );
  },
});

export const revisePortfolioCopy = action({
  args: {
    ...tokenValidator.fields,
    ...inputValidator.fields,
    ...generatedValidator.fields,
    userRequest: v.string(),
    customPrompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (token.length === 0) {
      throw new Error("Unauthorized");
    }

    const activeUser = await ctx.runQuery(currentUserByToken, { token });
    if (!activeUser) {
      throw new Error("Unauthorized");
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing OPENROUTER_API_KEY in process env. Set it in .env.local.",
      );
    }

    const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
    const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
      .trim()
      .replace(/\/+$/, "");
    const completionsPath = (process.env.OPENROUTER_COMPLETIONS_PATH || "/chat/completions").trim();
    const normalizedPath = completionsPath.startsWith("/")
      ? completionsPath
      : `/${completionsPath}`;
    const completionsUrl = `${baseUrl}${normalizedPath}`;

    const customBlock = args.customPrompt?.trim()
      ? `\n\nCRITICAL CUSTOM INSTRUCTIONS:\n================================\n${args.customPrompt.trim()}\n================================\nYOU MUST STRICTLY FOLLOW THESE INSTRUCTIONS.`
      : "";

    const userPrompt = `Revise the following Roblox portfolio based on user feedback.
Return valid JSON ONLY using the exact same schema. Apply the feedback precisely while maintaining quality across all sections.

User feedback (THIS IS YOUR HIGHEST PRIORITY):
================================
${args.userRequest}
================================

Brief context:
- Username: ${args.robloxUsername}
- Role: ${args.primaryRole}
- Signature style: ${args.signatureStyle}
- Notable projects: ${args.notableProjects}
- Skill focus: ${args.skillFocus}
- Target audience: ${args.targetAudience}${customBlock}

Current portfolio JSON:
${JSON.stringify({
      headline: args.headline,
      elevatorPitch: args.elevatorPitch,
      about: args.about,
      skills: args.skills,
      highlightedProjects: args.highlightedProjects,
      sectionBlocks: args.sectionBlocks,
      theme: args.theme,
      cta: args.cta,
    }, null, 2)}

Return ONLY valid JSON. No markdown fences, no explanation.`;

    return await runOpenRouterCompletion(
      ctx,
      args.streamId,
      {
        model,
        apiKey,
        completionsUrl,
        systemPrompt: buildSystemPrompt(),
        userPrompt,
      }
    );
  },
});

const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 5000;
const MAX_SKILLS = 50;
const MAX_PROJECTS = 20;
const MAX_SECTIONS = 20;

function assertFieldLengths(args: {
  robloxUsername: string;
  primaryRole: string;
  headline: string;
  elevatorPitch: string;
  about: string;
  cta: string;
  skills: string[];
  highlightedProjects: unknown[];
  sectionBlocks: unknown[];
}) {
  if (args.robloxUsername.length > MAX_SHORT_TEXT) throw new Error("Roblox username is too long.");
  if (args.primaryRole.length > MAX_SHORT_TEXT) throw new Error("Primary role is too long.");
  if (args.headline.length > MAX_SHORT_TEXT) throw new Error("Headline is too long.");
  if (args.elevatorPitch.length > MAX_LONG_TEXT) throw new Error("Elevator pitch is too long.");
  if (args.about.length > MAX_LONG_TEXT) throw new Error("About section is too long.");
  if (args.cta.length > MAX_SHORT_TEXT) throw new Error("Call to action is too long.");
  if (args.skills.length > MAX_SKILLS) throw new Error("Too many skills.");
  if (args.highlightedProjects.length > MAX_PROJECTS) throw new Error("Too many projects.");
  if (args.sectionBlocks.length > MAX_SECTIONS) throw new Error("Too many sections.");
}

export const savePortfolio = mutation({
  args: {
    ...tokenValidator.fields,
    ...inputValidator.fields,
    ...generatedValidator.fields,
  },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);
    assertFieldLengths(args);

    const id = await ctx.db.insert("portfolios", {
      userId: user._id,
      robloxUsername: args.robloxUsername,
      primaryRole: args.primaryRole,
      signatureStyle: args.signatureStyle,
      notableProjects: args.notableProjects,
      skillFocus: args.skillFocus,
      targetAudience: args.targetAudience,
      customPrompt: args.customPrompt || undefined,
      headline: args.headline,
      elevatorPitch: args.elevatorPitch,
      about: args.about,
      skills: args.skills,
      highlightedProjects: args.highlightedProjects,
      sectionBlocks: args.sectionBlocks,
      theme: args.theme,
      cta: args.cta,
      createdAt: Date.now(),
    });
    return id;
  },
});

export const listPortfolios = query({
  args: {
    ...tokenValidator.fields,
  },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);

    const docs = await ctx.db
      .query("portfolios")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(24);

    return docs.map((item) => ({
      _id: item._id,
      robloxUsername: item.robloxUsername,
      primaryRole: item.primaryRole,
      headline: item.headline,
      publicSlug: item.publicSlug,
      createdAt: item.createdAt,
    }));
  },
});

export const getPublicPortfolioBySlug = query({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = args.slug.trim().toLowerCase();
    if (!slug) {
      return null;
    }

    const portfolio = await ctx.db
      .query("portfolios")
      .withIndex("by_publicSlug", (q) => q.eq("publicSlug", slug))
      .unique();

    if (!portfolio) {
      return null;
    }

    return {
      robloxUsername: portfolio.robloxUsername,
      primaryRole: portfolio.primaryRole,
      headline: portfolio.headline,
      elevatorPitch: portfolio.elevatorPitch,
      about: portfolio.about,
      skills: portfolio.skills,
      highlightedProjects: portfolio.highlightedProjects.map(p => ({
        name: p.name,
        summary: p.summary,
        stack: p.stack,
        impact: p.impact,
        imageUrl: p.imageUrl,
        gameUrl: p.gameUrl,
      })),
      sectionBlocks: portfolio.sectionBlocks,
      theme: portfolio.theme,
      cta: portfolio.cta,
    };
  },
});

export const publishPortfolio = mutation({
  args: {
    ...tokenValidator.fields,
    portfolioId: v.id("portfolios"),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);
    const slug = args.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) {
      throw new Error("Slug must be 3-40 chars: lowercase letters, numbers, hyphens.");
    }

    const portfolio = await ctx.db.get(args.portfolioId);
    if (!portfolio || portfolio.userId !== user._id) {
      throw new Error("Portfolio not found.");
    }

    const existing = await ctx.db
      .query("portfolios")
      .withIndex("by_publicSlug", (q) => q.eq("publicSlug", slug))
      .unique();

    if (existing && existing._id !== args.portfolioId) {
      throw new Error("That subdomain is already taken.");
    }

    const publishedAt = Date.now();
    await ctx.db.patch(args.portfolioId, {
      publicSlug: slug,
      publishedAt,
    });

    return { slug, publishedAt };
  },
});

export const generateUploadUrl = mutation({
  args: {
    ...tokenValidator.fields,
  },
  handler: async (ctx, args) => {
    await requireUserByToken(ctx.db, args.token);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getImageUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const createStream = mutation({
  args: {
    ...tokenValidator.fields,
    purpose: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUserByToken(ctx.db, args.token);
    return await ctx.db.insert("streams", {
      userId: user._id,
      purpose: args.purpose,
      text: "",
      state: "streaming",
      updatedAt: Date.now(),
    });
  },
});

export const appendStream = internalMutation({
  args: {
    streamId: v.id("streams"),
    textChunk: v.string(),
    isDone: v.boolean(),
    isError: v.boolean(),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) return;

    let state = stream.state;
    if (args.isError) state = "error";
    else if (args.isDone) state = "completed";

    await ctx.db.patch(args.streamId, {
      text: stream.text + args.textChunk,
      state,
      updatedAt: Date.now(),
    });
  },
});

export const getStream = query({
  args: {
    streamId: v.id("streams"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.streamId);
  },
});
