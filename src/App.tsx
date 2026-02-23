import { useConvex, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { PortfolioPreview } from "./PortfolioPreview";

/* ═══════════════════════════════════════
   TYPES
   ═══════════════════════════════════════ */

type BuilderInput = {
  robloxUsername: string;
  primaryRole: string;
  signatureStyle: string;
  skillFocus: string;
  targetAudience: string;
  customPrompt: string;
};

type ProjectInput = {
  id: string;
  name: string;
  summary: string;
  gameUrl: string;
  imageUrl: string;
  imageFile: File | null;
  storageId?: string;
};

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
  }>;
  sectionBlocks: Array<{ title: string; body: string }>;
  cta: string;
};

type StoredPortfolio = {
  _id: string;
  robloxUsername: string;
  primaryRole: string;
  headline: string;
  publicSlug?: string;
  createdAt: number;
};

type AuthMode = "signup" | "login";
type AuthForm = { username: string; password: string };
type AuthSession = { token: string; username: string };
type ConvexArgs = Record<string, Value>;

type ChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  tone: "thinking" | "result" | "info";
  text: string;
};

/* ═══════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════ */

const TOKEN_KEY = "bloxfolio.auth.token";
const USER_KEY = "bloxfolio.auth.username";

const authRefs = {
  signUp: makeFunctionReference<"mutation">("auth:signUp"),
  logIn: makeFunctionReference<"mutation">("auth:logIn"),
  logOut: makeFunctionReference<"mutation">("auth:logout"),
} as const;

const portfolioRefs = {
  generate: makeFunctionReference<"action">("portfolio:generatePortfolioCopy"),
  revise: makeFunctionReference<"action">("portfolio:revisePortfolioCopy"),
  save: makeFunctionReference<"mutation">("portfolio:savePortfolio"),
  publish: makeFunctionReference<"mutation">("portfolio:publishPortfolio"),
  list: makeFunctionReference<"query">("portfolio:listPortfolios"),
  createStream: makeFunctionReference<"mutation">("portfolio:createStream"),
  getStream: makeFunctionReference<"query">("portfolio:getStream"),
  generateUploadUrl: makeFunctionReference<"mutation">("portfolio:generateUploadUrl"),
} as const;

const paymentRefs = {
  checkStatus: makeFunctionReference<"query">("payments:checkPaymentStatus"),
  createCheckout: makeFunctionReference<"action">("payments:createCheckoutSession"),
} as const;

const bargainRefs = {
  getSession: makeFunctionReference<"query">("bargain:getSession"),
  startSession: makeFunctionReference<"mutation">("bargain:startSession"),
  sendMessage: makeFunctionReference<"action">("bargain:sendMessage"),
} as const;

const defaultInput: BuilderInput = {
  robloxUsername: "",
  primaryRole: "",
  signatureStyle: "",
  skillFocus: "",
  targetAudience: "",
  customPrompt: "",
};

/* ═══════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMsg(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function shouldRetryWithoutToken(error: unknown): boolean {
  const m = errMsg(error, "");
  return (
    m.includes("ArgumentValidationError") ||
    m.includes("extra field `token`") ||
    m.includes("object has extra field")
  );
}

function parseSession(raw: unknown, fallback: string): AuthSession {
  if (!isRecord(raw)) throw new Error("Auth response malformed.");
  const tokenCandidate = [raw.token, raw.accessToken, raw.jwt].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (!tokenCandidate) throw new Error("No token returned.");
  const username =
    (typeof raw.username === "string" && raw.username.trim()) || fallback;
  return { token: tokenCandidate, username };
}

function readStoredSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  const token = window.localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  return {
    token,
    username: window.localStorage.getItem(USER_KEY) ?? "Builder",
  };
}

function normalizeStored(raw: unknown): StoredPortfolio[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item._id === "string" ? item._id : "";
    if (!id) return [];
    return [
      {
        _id: id,
        robloxUsername:
          typeof item.robloxUsername === "string"
            ? item.robloxUsername
            : "Unknown",
        primaryRole:
          typeof item.primaryRole === "string"
            ? item.primaryRole
            : "Role unavailable",
        headline:
          typeof item.headline === "string"
            ? item.headline
            : "Headline unavailable",
        publicSlug:
          typeof item.publicSlug === "string" ? item.publicSlug : undefined,
        createdAt:
          typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      },
    ];
  });
}

/* ═══════════════════════════════════════
   APPLICATION
   ═══════════════════════════════════════ */

function App() {
  const convex = useConvex();

  const hasDeployment = Boolean(import.meta.env.VITE_CONVEX_URL);
  const modelTag =
    import.meta.env.VITE_OPENROUTER_MODEL || "google/gemini-2.5-flash";
  const portfolioHost =
    import.meta.env.VITE_CONVEX_SITE_URL?.replace(/\/+$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");

  // Auth
  const [session, setSession] = useState<AuthSession | null>(() =>
    readStoredSession(),
  );
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [authForm, setAuthForm] = useState<AuthForm>({
    username: "",
    password: "",
  });
  const [authBusy, setAuthBusy] = useState(false);

  // Builder
  const [input, setInput] = useState<BuilderInput>(defaultInput);
  const [projects, setProjects] = useState<ProjectInput[]>([
    { id: Date.now().toString(), name: "", summary: "", gameUrl: "", imageUrl: "", imageFile: null }
  ]);
  const [generated, setGenerated] = useState<GeneratedPortfolio | null>(null);
  const [stored, setStored] = useState<StoredPortfolio[]>([]);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Publish
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(
    null,
  );
  const [publishSlug, setPublishSlug] = useState("");
  const [publishUrl, setPublishUrl] = useState<string | null>(null);

  // Loading states
  const [isGenerating, setIsGenerating] = useState(false);
  const [isChatBusy, setIsChatBusy] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isLoadingStored, setIsLoadingStored] = useState(false);

  // Feedback
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Payment & Bargain
  const [showBargain, setShowBargain] = useState(false);
  const [bargainInput, setBargainInput] = useState("");
  const [isBargainSending, setIsBargainSending] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const bargainChatEndRef = useRef<HTMLDivElement>(null);

  const paymentStatus = (useQuery as any)(
    paymentRefs.checkStatus,
    session ? { token: session.token } : "skip",
  );
  const hasPaid: boolean = paymentStatus === true;

  const bargainData = (useQuery as any)(
    bargainRefs.getSession,
    session && paymentStatus === false ? { token: session.token } : "skip",
  );

  // Streaming Reasoning
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const streamData = (useQuery as any)(
    portfolioRefs.getStream,
    activeStreamId ? { streamId: activeStreamId } : "skip"
  );

  useEffect(() => {
    if (activeStreamId && streamData) {
      setChatMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === activeStreamId);
        const textToDisplay = streamData.text || "Thinking...";

        if (idx !== -1) {
          next[idx] = { ...next[idx], text: textToDisplay };
        } else {
          next.push({
            id: activeStreamId,
            role: "assistant",
            tone: "thinking",
            text: textToDisplay,
          });
        }
        return next;
      });
    }
  }, [activeStreamId, streamData]);

  const briefSummary = useMemo(
    () =>
      [input.robloxUsername, input.primaryRole, input.targetAudience]
        .filter(Boolean)
        .join(" → "),
    [input.robloxUsername, input.primaryRole, input.targetAudience],
  );

  // Convex wrappers
  const runQuery = useCallback(
    async <T,>(ref: FunctionReference<"query">, args: ConvexArgs): Promise<T> =>
      (await convex.query(ref, args)) as T,
    [convex],
  );

  const runMutation = useCallback(
    async <T,>(
      ref: FunctionReference<"mutation">,
      args: ConvexArgs,
    ): Promise<T> => (await convex.mutation(ref, args)) as T,
    [convex],
  );

  const runAction = useCallback(
    async <T,>(
      ref: FunctionReference<"action">,
      args: ConvexArgs,
    ): Promise<T> => (await convex.action(ref, args)) as T,
    [convex],
  );

  // Auto-dismiss error/success
  useEffect(() => {
    if (!error && !success) return;
    const t = setTimeout(() => {
      setError(null);
      setSuccess(null);
    }, 6000);
    return () => clearTimeout(t);
  }, [error, success]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Progress stream (fake thinking stages)
  const startProgress = useCallback(
    async (mode: "generate" | "revise", token: string) => {
      try {
        const streamId = await (convex.mutation as any)(portfolioRefs.createStream, { token, purpose: mode });
        setActiveStreamId(streamId);
        return streamId;
      } catch (err) {
        console.error("Could not start stream", err);
        return null; // Fallback to non-streaming if table missing etc
      }
    },
    [convex],
  );

  const stopProgress = useCallback(() => {
    setActiveStreamId(null);
  }, []);

  // Clean up progress on unmount
  useEffect(() => () => stopProgress(), [stopProgress]);

  // Session management
  const clearSession = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(USER_KEY);
    }
    stopProgress();
    setSession(null);
    setGenerated(null);
    setStored([]);
    setChatMessages([]);
    setSelectedPortfolioId(null);
    setPublishSlug("");
    setPublishUrl(null);
    setError(null);
    setSuccess(null);
  }, [stopProgress]);

  // Load saved portfolios
  const loadStored = useCallback(
    async (token: string) => {
      if (!hasDeployment) {
        setStored([]);
        return;
      }
      setIsLoadingStored(true);
      try {
        const data = await runQuery<unknown>(portfolioRefs.list, {
          token,
        } as ConvexArgs);
        setStored(normalizeStored(data));
      } catch (firstErr) {
        if (shouldRetryWithoutToken(firstErr)) {
          try {
            const data = await runQuery<unknown>(
              portfolioRefs.list,
              {} as ConvexArgs,
            );
            setStored(normalizeStored(data));
            return;
          } catch (legacyErr) {
            setError(errMsg(legacyErr, "Unable to load saved portfolios."));
            return;
          }
        }
        setError(errMsg(firstErr, "Unable to load saved portfolios."));
      } finally {
        setIsLoadingStored(false);
      }
    },
    [hasDeployment, runQuery],
  );

  // Load on session change
  useEffect(() => {
    if (!session?.token || !hasDeployment) {
      setStored([]);
      return;
    }
    void loadStored(session.token);
  }, [hasDeployment, loadStored, session?.token]);

  // Auto-scroll bargain chat
  useEffect(() => {
    bargainChatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bargainData?.messages]);

  // Handle Stripe redirect URL params
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      setSuccess("Payment processing... you'll be redirected momentarily.");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("payment") === "cancel") {
      setError("Payment cancelled.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  /* ─────── PAYMENT & BARGAIN ─────── */

  const onCheckout = async (amount: 899 | 499) => {
    if (!session?.token) return;
    setIsCheckingOut(true);
    setError(null);
    try {
      const result = await runAction<{ url: string }>(
        paymentRefs.createCheckout,
        {
          token: session.token,
          amount,
          returnUrl: window.location.origin + window.location.pathname,
        } as ConvexArgs,
      );
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      setError(errMsg(err, "Checkout failed."));
      setIsCheckingOut(false);
    }
  };

  const onStartBargain = async () => {
    if (!session?.token) return;
    setError(null);
    try {
      await runMutation(bargainRefs.startSession, { token: session.token } as ConvexArgs);
      setShowBargain(true);
    } catch (err) {
      setError(errMsg(err, "Failed to start bargain session."));
    }
  };

  const onBargainSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const msg = bargainInput.trim();
    if (!msg || !session?.token || !bargainData?._id || isBargainSending) return;
    setBargainInput("");
    setIsBargainSending(true);
    setError(null);
    try {
      await runAction(bargainRefs.sendMessage, {
        token: session.token,
        message: msg,
        sessionId: bargainData._id,
      } as ConvexArgs);
    } catch (err) {
      setError(errMsg(err, "Failed to send message."));
    } finally {
      setIsBargainSending(false);
    }
  };

  /* ─────── AUTH ─────── */

  const onAuthSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const uname = authForm.username.trim();
    if (uname.length < 3)
      return void setError("Username must be at least 3 characters.");
    if (authForm.password.length < 8)
      return void setError("Password must be at least 8 characters.");
    if (!hasDeployment)
      return void setError("Add VITE_CONVEX_URL in .env.local first.");

    setAuthBusy(true);
    try {
      const fn =
        authMode === "signup" ? authRefs.signUp : authRefs.logIn;
      const raw = await runMutation<unknown>(fn, {
        username: uname,
        password: authForm.password,
      } as ConvexArgs);
      const next = parseSession(raw, uname);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(TOKEN_KEY, next.token);
        window.localStorage.setItem(USER_KEY, next.username);
      }
      setSession(next);
      setAuthForm({ username: "", password: "" });
      setSuccess(
        authMode === "signup" ? "Account created." : "Logged in.",
      );
      await loadStored(next.token);
    } catch (err) {
      setError(errMsg(err, "Authentication failed."));
    } finally {
      setAuthBusy(false);
    }
  };

  /* ─────── GENERATE ─────── */

  const uploadImages = async (token: string): Promise<ProjectInput[]> => {
    const updatedProjects = [...projects];
    for (let i = 0; i < updatedProjects.length; i++) {
      const p = updatedProjects[i];
      if (p.imageFile && !p.storageId) {
        setChatMessages((prev) => [
          ...prev.filter(m => m.tone !== "thinking"),
          { id: `${Date.now()}-upload-${i}`, role: "system", tone: "info", text: `Uploading image for ${p.name || "project"}...` }
        ]);

        const postUrl = await runMutation<string>(portfolioRefs.generateUploadUrl, { token } as ConvexArgs);
        const result = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": p.imageFile.type },
          body: p.imageFile,
        });
        const { storageId } = await result.json();
        updatedProjects[i].storageId = storageId;
        updatedProjects[i].imageUrl = storageId; // Use storageId as imageUrl for the backend
      }
    }
    setProjects(updatedProjects);
    return updatedProjects;
  };

  const serializeProjects = (projs: ProjectInput[]) => {
    return JSON.stringify(projs.map(p => ({
      name: p.name,
      summary: p.summary,
      gameUrl: p.gameUrl,
      imageUrl: p.storageId || p.imageUrl
    })));
  };

  const onGenerate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!session?.token)
      return void setError("Log in to generate portfolio copy.");
    if (!hasDeployment)
      return void setError("Set VITE_CONVEX_URL and run convex dev.");

    setIsGenerating(true);
    setChatMessages([
      {
        id: `${Date.now()}-start`,
        role: "system",
        tone: "info",
        text: `Forging portfolio for @${input.robloxUsername || "you"}...`,
      },
    ]);
    const streamId = await startProgress("generate", session.token);

    try {
      const finalProjects = await uploadImages(session.token);
      const actionArgs = {
        robloxUsername: input.robloxUsername,
        primaryRole: input.primaryRole,
        signatureStyle: input.signatureStyle,
        notableProjects: serializeProjects(finalProjects),
        skillFocus: input.skillFocus,
        targetAudience: input.targetAudience,
        customPrompt: input.customPrompt || "",
        streamId,
        token: session.token,
      } as ConvexArgs;


      let result: GeneratedPortfolio;
      try {
        result = await runAction<GeneratedPortfolio>(
          portfolioRefs.generate,
          actionArgs,
        );
      } catch (firstErr) {
        if (!shouldRetryWithoutToken(firstErr)) throw firstErr;
        const { token: _t, ...rest } = actionArgs;
        void _t;
        result = await runAction<GeneratedPortfolio>(
          portfolioRefs.generate,
          rest as ConvexArgs,
        );
      }

      setGenerated(result);
      setChatMessages((prev) => [
        ...prev.filter((m) => m.tone !== "thinking"),
        {
          id: `${Date.now()}-done`,
          role: "assistant",
          tone: "result",
          text: `Portfolio forged. Here's your headline:\n\n"${result.headline}"\n\nScroll down to preview the full result, or tell me what to change.`,
        },
      ]);
      setSuccess("Portfolio generated.");
    } catch (err) {
      setChatMessages((prev) => [
        ...prev.filter((m) => m.tone !== "thinking"),
        {
          id: `${Date.now()}-err`,
          role: "system",
          tone: "info",
          text: `Generation failed: ${errMsg(err, "Unknown error")}`,
        },
      ]);
      setError(errMsg(err, "Generation failed."));
    } finally {
      stopProgress();
      setIsGenerating(false);
    }
  };

  /* ─────── CHAT REVISE ─────── */

  const onChatSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const prompt = chatInput.trim();
    if (!prompt || !generated || !session?.token || isChatBusy) return;
    setError(null);
    setSuccess(null);
    setChatInput("");
    setIsChatBusy(true);

    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-user`,
        role: "user",
        tone: "result",
        text: prompt,
      },
    ]);

    const streamId = await startProgress("revise", session.token);

    try {
      const finalProjects = await uploadImages(session.token);
      const revised = await runAction<GeneratedPortfolio>(
        portfolioRefs.revise,
        {
          ...input,
          notableProjects: serializeProjects(finalProjects),
          ...generated,
          streamId,
          token: session.token,
          userRequest: prompt,
          customPrompt: input.customPrompt || "",
        } as ConvexArgs,
      );
      setGenerated(revised);
      setChatMessages((prev) => [
        ...prev.filter((m) => m.tone !== "thinking"),
        {
          id: `${Date.now()}-revised`,
          role: "assistant",
          tone: "result",
          text: `Done. I've updated the portfolio based on your feedback.\n\nNew headline: "${revised.headline}"\n\nPreview updated below.`,
        },
      ]);
      setSuccess("Portfolio revised.");
    } catch (err) {
      setChatMessages((prev) => [
        ...prev.filter((m) => m.tone !== "thinking"),
        {
          id: `${Date.now()}-err`,
          role: "system",
          tone: "info",
          text: `Revision failed: ${errMsg(err, "Unknown error")}`,
        },
      ]);
      setError(errMsg(err, "Revision failed."));
    } finally {
      stopProgress();
      setIsChatBusy(false);
    }
  };

  /* ─────── SAVE ─────── */

  const onSave = async () => {
    if (!generated) return;
    if (!session?.token)
      return void setError("Log in to save portfolio results.");
    setError(null);
    setSuccess(null);
    setIsSaving(true);
    try {
      const finalProjects = await uploadImages(session.token);
      const saveArgs = {
        robloxUsername: input.robloxUsername,
        primaryRole: input.primaryRole,
        signatureStyle: input.signatureStyle,
        notableProjects: serializeProjects(finalProjects),
        skillFocus: input.skillFocus,
        targetAudience: input.targetAudience,
        customPrompt: input.customPrompt || "",
        ...generated,
        token: session.token,
      } as ConvexArgs;
      let id: string;
      try {
        id = await runMutation<string>(portfolioRefs.save, saveArgs);
      } catch (firstErr) {
        if (!shouldRetryWithoutToken(firstErr)) throw firstErr;
        const { token: _t, ...rest } = saveArgs;
        void _t;
        id = await runMutation<string>(
          portfolioRefs.save,
          rest as ConvexArgs,
        );
      }
      setSelectedPortfolioId(id);
      setSuccess("Portfolio saved.");
      await loadStored(session.token);
    } catch (err) {
      setError(errMsg(err, "Unable to save."));
    } finally {
      setIsSaving(false);
    }
  };

  /* ─────── PUBLISH ─────── */

  const onPublish = async () => {
    if (!session?.token || !selectedPortfolioId)
      return void setError("Save/select a portfolio first.");
    const slug = publishSlug.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug))
      return void setError(
        "Use 3-40 chars: lowercase letters, numbers, hyphens.",
      );

    setError(null);
    setSuccess(null);
    setIsPublishing(true);
    try {
      const result = await runMutation<{ slug: string }>(
        portfolioRefs.publish,
        {
          token: session.token,
          portfolioId: selectedPortfolioId,
          slug,
        } as ConvexArgs,
      );
      setPublishUrl(`${portfolioHost}/p/${result.slug}`);
      setSuccess("Published. URL ready.");
      await loadStored(session.token);
    } catch (err) {
      setError(errMsg(err, "Unable to publish."));
    } finally {
      setIsPublishing(false);
    }
  };

  /* ═══════════════════════════════════════
     RENDER: LANDING PAGE
     ═══════════════════════════════════════ */

  if (!session) {
    return (
      <div className="landing">
        <nav className="nav">
          <div className="nav-inner">
            <div className="nav-brand">
              <div className="logo-block" />
              <span className="logo-text">BLOXFOLIO</span>
            </div>
          </div>
        </nav>

        <section className="hero">
          <div className="hero-inner">
            <div className="hero-badge">For Roblox Developers</div>
            <h1 className="hero-title">
              Forge Your
              <br />
              <span className="accent">Portfolio</span>
            </h1>
            <p className="hero-desc">
              AI-powered portfolio builder designed for Roblox developers.
              Generate, chat-revise, and publish — starting at $4.99 if
              you can bargain for it.
            </p>
            <a href="#auth" className="hero-cta">
              Start Building →
            </a>
          </div>

          <div className="hero-deco">
            <div className="deco-block block-1" />
            <div className="deco-block block-2" />
            <div className="deco-block block-3" />
          </div>
        </section>

        <section className="steps">
          <div className="steps-inner">
            <h2 className="steps-title">How it works</h2>
            <div className="steps-grid">
              <div className="step-card">
                <span className="step-num">01</span>
                <h3>Unlock</h3>
                <p>
                  Pay $8.99 — or bargain with ROBUCKS, our stubborn AI
                  merchant, to unlock the $4.99 deal. If you can impress him.
                </p>
              </div>
              <div className="step-card">
                <span className="step-num">02</span>
                <h3>Forge</h3>
                <p>
                  Fill in your brief and watch the AI reason through your
                  positioning. Chat to revise tone, structure, and outcomes.
                </p>
              </div>
              <div className="step-card">
                <span className="step-num">03</span>
                <h3>Ship</h3>
                <p>
                  Save variants, claim a URL, and publish your portfolio for
                  studios and publishers to find.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="auth-section" id="auth">
          <div className="auth-inner">
            <div className="auth-header">
              <h2>Enter the Forge</h2>
              <p>Create an account or sign in to start building.</p>
            </div>
            <div className="auth-card">
              <div className="auth-tabs">
                <button
                  type="button"
                  className={authMode === "signup" ? "active" : ""}
                  onClick={() => setAuthMode("signup")}
                >
                  Sign Up
                </button>
                <button
                  type="button"
                  className={authMode === "login" ? "active" : ""}
                  onClick={() => setAuthMode("login")}
                >
                  Log In
                </button>
              </div>
              <form className="auth-form" onSubmit={onAuthSubmit}>
                <label>
                  <span>Username</span>
                  <input
                    type="text"
                    value={authForm.username}
                    onChange={(e) =>
                      setAuthForm((p) => ({
                        ...p,
                        username: e.target.value,
                      }))
                    }
                    placeholder="Your Roblox username"
                    required
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(e) =>
                      setAuthForm((p) => ({
                        ...p,
                        password: e.target.value,
                      }))
                    }
                    placeholder="Min 8 characters"
                    required
                  />
                </label>
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={authBusy}
                >
                  {authBusy
                    ? "Working..."
                    : authMode === "signup"
                      ? "Create Account"
                      : "Sign In"}
                </button>
              </form>
              {error ? <div className="alert alert-error">{error}</div> : null}
              {success ? (
                <div className="alert alert-success">{success}</div>
              ) : null}
            </div>
          </div>
        </section>

        <footer className="footer">
          <p>Bloxfolio — Built for Roblox developers</p>
        </footer>
      </div>
    );
  }

  /* ═══════════════════════════════════════
     RENDER: LOADING / PAYMENT GATE
     ═══════════════════════════════════════ */

  if (paymentStatus === undefined) {
    return (
      <div className="loading-gate">
        <div className="loading-spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!hasPaid) {
    const moodPercent = bargainData?.mood ?? 0;
    const moodColor =
      moodPercent >= 80
        ? "var(--success)"
        : moodPercent >= 50
          ? "var(--accent)"
          : moodPercent >= 30
            ? "#ff8800"
            : "var(--error)";
    const discountUnlocked = bargainData?.discountUnlocked === true;

    return (
      <div className="pricing-gate">
        <header className="ws-nav">
          <div className="ws-brand">
            <div className="logo-block" />
            <span>BLOXFOLIO</span>
          </div>
          <div className="ws-meta">
            <span className="ws-chip user-chip">@{session.username}</span>
            <button
              className="ws-logout"
              type="button"
              onClick={() => void clearSession()}
            >
              Log out
            </button>
          </div>
        </header>

        <div className="pricing-content">
          <div className="pricing-hero">
            <h1 className="pricing-title">
              Unlock The <span className="accent">Forge</span>
            </h1>
            <p className="pricing-subtitle">
              Build your AI-powered Roblox portfolio. Choose your path.
            </p>
          </div>

          <div className="pricing-cards">
            <div className="pricing-card">
              <div className="pricing-card-badge">Standard</div>
              <div className="pricing-amount">
                <span className="pricing-dollar">$</span>
                <span className="pricing-number">8</span>
                <span className="pricing-cents">.99</span>
              </div>
              <p className="pricing-desc">
                Full price. No games. Instant access to the AI portfolio forge.
              </p>
              <ul className="pricing-features">
                <li>AI-powered portfolio generation</li>
                <li>Chat-based revisions</li>
                <li>Custom themes & fonts</li>
                <li>Publish with custom URL</li>
              </ul>
              <button
                className="btn-primary pricing-btn"
                onClick={() => void onCheckout(899)}
                disabled={isCheckingOut}
              >
                {isCheckingOut ? "Redirecting..." : "Pay & Build"}
              </button>
            </div>

            <div className={`pricing-card pricing-card-deal ${discountUnlocked ? "deal-unlocked" : ""}`}>
              <div className="pricing-card-badge deal-badge">
                {discountUnlocked ? "UNLOCKED" : "THE DEAL"}
              </div>
              <div className="pricing-amount">
                <span className="pricing-dollar">$</span>
                <span className="pricing-number">4</span>
                <span className="pricing-cents">.99</span>
              </div>
              {!discountUnlocked && (
                <div className="deal-lock-icon">LOCKED</div>
              )}
              <p className="pricing-desc">
                {discountUnlocked
                  ? "ROBUCKS is impressed. The deal is yours."
                  : "Convince ROBUCKS the merchant to unlock this price."}
              </p>
              {discountUnlocked ? (
                <button
                  className="btn-primary pricing-btn deal-btn-unlocked"
                  onClick={() => void onCheckout(499)}
                  disabled={isCheckingOut}
                >
                  {isCheckingOut ? "Redirecting..." : "Claim The Deal"}
                </button>
              ) : (
                <button
                  className="btn-secondary pricing-btn"
                  onClick={() => {
                    if (!bargainData) {
                      void onStartBargain();
                    } else {
                      setShowBargain(true);
                    }
                  }}
                >
                  {bargainData ? "Continue Bargaining" : "Bargain with ROBUCKS"}
                </button>
              )}
            </div>
          </div>

          {/* Bargain Bot Interface */}
          {(showBargain || bargainData) && bargainData && (
            <div className="bargain-section">
              <div className="bargain-header">
                <h2>Bargain with ROBUCKS</h2>
                <div className="mood-display">
                  <span className="mood-label">MOOD</span>
                  <div className="mood-bar-track">
                    <div
                      className={`mood-bar-fill ${discountUnlocked ? "mood-success" : ""}`}
                      style={{
                        width: `${moodPercent}%`,
                        background: moodColor,
                      }}
                    />
                    <div className="mood-threshold-marker" />
                  </div>
                  <span className="mood-value" style={{ color: moodColor }}>
                    {moodPercent}/100
                  </span>
                </div>
                {!discountUnlocked && (
                  <p className="mood-hint">
                    Reach 80 to unlock the deal. Good luck.
                  </p>
                )}
              </div>

              <div className="bargain-chat">
                <div className="bargain-messages">
                  {(bargainData.messages || []).map(
                    (msg: { role: string; text: string }, i: number) => (
                      <div
                        key={i}
                        className={`bargain-msg ${msg.role === "user" ? "bargain-msg-user" : "bargain-msg-bot"}`}
                      >
                        {msg.role === "assistant" && (
                          <span className="bargain-avatar">R</span>
                        )}
                        <div className="bargain-msg-content">{msg.text}</div>
                      </div>
                    ),
                  )}
                  {isBargainSending && (
                    <div className="bargain-msg bargain-msg-bot">
                      <span className="bargain-avatar">R</span>
                      <div className="bargain-msg-content bargain-thinking">
                        ROBUCKS is thinking...
                      </div>
                    </div>
                  )}
                  <div ref={bargainChatEndRef} />
                </div>

                {!discountUnlocked && bargainData.messageCount < 50 && (
                  <form className="bargain-input" onSubmit={onBargainSubmit}>
                    <input
                      type="text"
                      placeholder="Say something to ROBUCKS..."
                      value={bargainInput}
                      onChange={(e) => setBargainInput(e.target.value)}
                      disabled={isBargainSending}
                    />
                    <button type="submit" disabled={isBargainSending || !bargainInput.trim()}>
                      {isBargainSending ? "..." : "Send"}
                    </button>
                  </form>
                )}

                {bargainData.messageCount >= 50 && !discountUnlocked && (
                  <div className="bargain-limit">
                    <p>Message limit reached. ROBUCKS has had enough.</p>
                    <button
                      className="btn-secondary"
                      onClick={() => void onStartBargain()}
                    >
                      Reset & Try Again
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {error && <div className="toast toast-error">{error}</div>}
        {success && <div className="toast toast-success">{success}</div>}
      </div>
    );
  }

  /* ═══════════════════════════════════════
     RENDER: WORKSPACE
     ═══════════════════════════════════════ */

  return (
    <div className="workspace">
      <header className="ws-nav">
        <div className="ws-brand">
          <div className="logo-block" />
          <span>BLOXFOLIO</span>
        </div>
        <div className="ws-meta">
          <span className="ws-chip user-chip">@{session.username}</span>
          <span className="ws-chip">{modelTag}</span>
          <button
            className="ws-logout"
            type="button"
            onClick={() => void clearSession()}
          >
            Log out
          </button>
        </div>
      </header>

      <div className="ws-layout">
        {/* ─── SIDEBAR ─── */}
        <aside className="ws-sidebar">
          <form className="brief-form" onSubmit={onGenerate}>
            <h3>Portfolio Brief</h3>
            {briefSummary && (
              <p
                style={{
                  fontSize: "0.78rem",
                  color: "var(--text-muted)",
                  marginBottom: "0.8rem",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                {briefSummary}
              </p>
            )}

            <div className="brief-fields">
              {/* SECTION 1: Identity */}
              <div className="input-section">
                <div className="input-section-header">
                  <h4>1. Developer Identity</h4>
                  <p>Who you are and how you fit into the Roblox ecosystem.</p>
                </div>
                <div className="field-row">
                  <div className="field-group">
                    <label>Roblox Username</label>
                    <input
                      type="text"
                      value={input.robloxUsername}
                      onChange={(e) =>
                        setInput((p) => ({
                          ...p,
                          robloxUsername: e.target.value,
                        }))
                      }
                      placeholder="e.g. StudioNebula"
                      required
                    />
                  </div>
                  <div className="field-group">
                    <label>Primary Role</label>
                    <input
                      type="text"
                      value={input.primaryRole}
                      onChange={(e) =>
                        setInput((p) => ({
                          ...p,
                          primaryRole: e.target.value,
                        }))
                      }
                      placeholder="e.g. Lead Gameplay Engineer"
                      required
                    />
                    <p className="field-help">Be specific. Avoid generic terms like "Programmer" if you specialize.</p>
                  </div>
                </div>
              </div>

              {/* SECTION 2: Experience */}
              <div className="input-section">
                <div className="input-section-header">
                  <h4>2. Experience & Focus</h4>
                  <p>What you actually build, ship, and obsess over.</p>
                </div>
                <div className="field-group">
                  <label>Signature Style / Build Philosophy</label>
                  <input
                    type="text"
                    value={input.signatureStyle}
                    onChange={(e) =>
                      setInput((p) => ({
                        ...p,
                        signatureStyle: e.target.value,
                      }))
                    }
                    placeholder="e.g. Systems-heavy combat loops with satisfying progression"
                    required
                  />
                  <p className="field-help">Summarize your design aesthetic or technical approach in one sentence.</p>
                </div>
                <div className="field-group project-list-group">
                  <div className="project-list-header">
                    <label>Notable Projects</label>
                    <button
                      type="button"
                      onClick={() => setProjects(p => [...p, { id: Date.now().toString(), name: "", summary: "", gameUrl: "", imageUrl: "", imageFile: null }])}
                      className="add-project-btn"
                    >
                      + ADD PROJECT
                    </button>
                  </div>

                  {projects.map((proj, i) => (
                    <div key={proj.id} className="project-input-card">
                      <div className="project-input-header">
                        <h5>Project {i + 1}</h5>
                        {projects.length > 1 && (
                          <button type="button" onClick={() => setProjects(p => p.filter(x => x.id !== proj.id))} className="remove-project-btn">✕</button>
                        )}
                      </div>
                      <input
                        type="text"
                        placeholder="Project Name (e.g. Neon Siege Arena)"
                        value={proj.name}
                        onChange={e => {
                          const newProjects = [...projects];
                          newProjects[i].name = e.target.value;
                          setProjects(newProjects);
                        }}
                        required
                      />
                      <textarea
                        placeholder="Summary & Impact (e.g. Shipped V1, 5K+ CCU, Custom LuaU Combat)"
                        value={proj.summary}
                        rows={2}
                        onChange={e => {
                          const newProjects = [...projects];
                          newProjects[i].summary = e.target.value;
                          setProjects(newProjects);
                        }}
                        required
                      />
                      <div className="project-media-inputs">
                        <input
                          type="text"
                          placeholder="Play Experience URL (https://roblox.com/...)"
                          value={proj.gameUrl}
                          onChange={e => {
                            const newProjects = [...projects];
                            newProjects[i].gameUrl = e.target.value;
                            setProjects(newProjects);
                          }}
                        />
                        <div className="file-upload-wrapper">
                          <span>{proj.imageFile ? proj.imageFile.name : "+ UPLOAD COVER IMAGE"}</span>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={e => {
                              const file = e.target.files?.[0] || null;
                              const newProjects = [...projects];
                              newProjects[i].imageFile = file;
                              newProjects[i].storageId = undefined; // clear old storage ID if they pick a new file
                              newProjects[i].imageUrl = "";
                              setProjects(newProjects);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <p className="field-help">Upload a striking 16:9 image and provide direct game links!</p>
                </div>
                <div className="field-row">
                  <div className="field-group">
                    <label>Skill Focus</label>
                    <input
                      type="text"
                      value={input.skillFocus}
                      onChange={(e) =>
                        setInput((p) => ({
                          ...p,
                          skillFocus: e.target.value,
                        }))
                      }
                      placeholder="e.g. LuaU, monetization, retention pipelines"
                      required
                    />
                    <p className="field-help">Comma-separated list of your sharpest tools.</p>
                  </div>
                  <div className="field-group">
                    <label>Target Audience</label>
                    <input
                      type="text"
                      value={input.targetAudience}
                      onChange={(e) =>
                        setInput((p) => ({
                          ...p,
                          targetAudience: e.target.value,
                        }))
                      }
                      placeholder="e.g. AAA Studios & ambitious publishers"
                      required
                    />
                    <p className="field-help">Who do you want reading this portfolio?</p>
                  </div>
                </div>
              </div>

              {/* SECTION 3: Instructions */}
              <div className="input-section accent-section">
                <div className="input-section-header">
                  <h4>3. AI Generation Directives</h4>
                  <p>Give the AI strictly enforced rules for this build.</p>
                </div>
                <div className="field-group">
                  <label>Custom Instructions (Optional)</label>
                  <textarea
                    value={input.customPrompt}
                    onChange={(e) =>
                      setInput((p) => ({
                        ...p,
                        customPrompt: e.target.value,
                      }))
                    }
                    placeholder="E.g. 'Emphasize my PvP combat systems', 'Make the tone extremely aggressive', 'Use a cyberpunk neon-pink theme'"
                    rows={3}
                  />
                  <p className="field-help">The AI will obey these custom instructions above all other rules.</p>
                </div>
              </div>
            </div>

            <button
              className={`generate-btn ${isGenerating ? "is-forging" : ""}`}
              type="submit"
              disabled={isGenerating}
            >
              {isGenerating ? "⚒ Forging..." : "⚒ Forge Portfolio"}
            </button>
          </form>

          <div className="archive-section">
            <div className="archive-header">
              <h3>Saved ({stored.length})</h3>
              <button
                type="button"
                onClick={() => void loadStored(session.token)}
                disabled={isLoadingStored}
              >
                {isLoadingStored ? "..." : "↻"}
              </button>
            </div>
            <div className="archive-list">
              {stored.map((item) => (
                <div
                  key={item._id}
                  className={`archive-item ${selectedPortfolioId === item._id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedPortfolioId(item._id);
                    if (item.publicSlug) {
                      setPublishSlug(item.publicSlug);
                      setPublishUrl(
                        `${portfolioHost}/p/${item.publicSlug}`,
                      );
                    }
                  }}
                >
                  <strong>{item.robloxUsername}</strong>
                  <span>{item.primaryRole}</span>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    {item.headline}
                  </span>
                  {item.publicSlug && (
                    <span style={{ fontSize: "0.7rem", color: "var(--accent)" }}>
                      /p/{item.publicSlug}
                    </span>
                  )}
                </div>
              ))}
              {!isLoadingStored && stored.length === 0 && (
                <p className="archive-empty">No saved portfolios</p>
              )}
            </div>
          </div>
        </aside>

        {/* ─── MAIN FORGE AREA ─── */}
        <main className="ws-main">
          <div className="forge-panel">
            <div className="forge-header">
              <h2>The Forge</h2>
              <div className="forge-actions">
                {generated && (
                  <>
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={() => void onSave()}
                      disabled={isSaving}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="chat-container">
              {chatMessages.length === 0 && !generated ? (
                <div className="chat-empty-state">
                  <div className="empty-icon">⚒</div>
                  <h3>Ready to forge</h3>
                  <p>
                    Fill in your brief on the left and hit &quot;Forge
                    Portfolio&quot; to begin. The AI will reason through your
                    positioning and generate a complete portfolio.
                  </p>
                </div>
              ) : (
                <div className="chat-messages">
                  {chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`chat-msg chat-${msg.role} ${msg.tone === "thinking" ? "thinking" : ""}`}
                    >
                      {msg.tone === "thinking" && (
                        <span className="thinking-indicator" />
                      )}
                      <div className="msg-content">{msg.text}</div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            {generated && (
              <form className="chat-input" onSubmit={onChatSubmit}>
                <input
                  type="text"
                  placeholder="Tell the AI what to change..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={isChatBusy}
                />
                <button type="submit" disabled={isChatBusy}>
                  {isChatBusy ? "..." : "Send"}
                </button>
              </form>
            )}
          </div>

          {/* Portfolio Preview */}
          {generated && (
            <div className="preview-panel">
              <div className="preview-toggle">
                <h2>Portfolio Preview</h2>
                <div className="forge-actions">
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => void onSave()}
                    disabled={isSaving}
                  >
                    {isSaving ? "Saving..." : "💾 Save"}
                  </button>
                </div>
              </div>

              <div className="preview-content">
                <PortfolioPreview data={generated} />
              </div>
            </div>
          )}

          {/* Publish bar */}
          {selectedPortfolioId && (
            <div className="publish-bar">
              <input
                type="text"
                placeholder="claim-subdomain"
                value={publishSlug}
                onChange={(e) => setPublishSlug(e.target.value)}
              />
              <button
                className="btn-secondary"
                type="button"
                onClick={() => void onPublish()}
                disabled={isPublishing || !selectedPortfolioId}
              >
                {isPublishing ? "..." : "Claim URL"}
              </button>
              {publishUrl && (
                <a href={publishUrl} target="_blank" rel="noreferrer">
                  Open →
                </a>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Toasts */}
      {error && <div className="toast toast-error">{error}</div>}
      {success && <div className="toast toast-success">{success}</div>}
    </div>
  );
}

export default App;
