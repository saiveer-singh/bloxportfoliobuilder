import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export type AuthenticatedUser = {
  _id: Id<"users">;
  username: string;
  createdAt: number;
};

function normalizeUsername(rawUsername: string): string {
  return rawUsername.trim();
}

function assertValidCredentials(username: string, password: string): void {
  if (
    username.length < MIN_USERNAME_LENGTH ||
    username.length > MAX_USERNAME_LENGTH
  ) {
    throw new Error(
      `Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters.`,
    );
  }

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("Username can only contain letters, numbers, and underscores.");
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex value.");
  }

  const bytes: number[] = [];
  for (let index = 0; index < hex.length / 2; index += 1) {
    const offset = index * 2;
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex value.");
    }
    bytes.push(value);
  }
  return new Uint8Array(bytes);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(bytes);
  return copied.buffer;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const passwordBytes = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 120_000,
      salt: toArrayBuffer(hexToBytes(saltHex)),
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(derived));
}

function hashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function createSession(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  await ctx.db.insert("sessions", {
    userId,
    tokenHash,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });

  return token;
}

async function lookupUserByToken(
  db: DatabaseReader,
  rawToken: string,
): Promise<AuthenticatedUser | null> {
  const token = rawToken.trim();
  if (token.length === 0) {
    return null;
  }

  const tokenHash = await sha256Hex(token);
  const session = await db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (!session || session.expiresAt <= Date.now()) {
    return null;
  }

  const user = await db.get(session.userId);
  if (!user) {
    return null;
  }

  return {
    _id: user._id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

export async function requireUserByToken(db: DatabaseReader, token: string) {
  const user = await lookupUserByToken(db, token);
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}

export const signUp = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const username = normalizeUsername(args.username);
    const usernameLower = username.toLowerCase();
    assertValidCredentials(username, args.password);

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_usernameLower", (q) => q.eq("usernameLower", usernameLower))
      .unique();
    if (existingUser) {
      throw new Error("Username already exists.");
    }

    const now = Date.now();
    const passwordSalt = randomHex(16);
    const passwordHash = await hashPassword(args.password, passwordSalt);

    const userId = await ctx.db.insert("users", {
      username,
      usernameLower,
      passwordHash,
      passwordSalt,
      createdAt: now,
    });
    const token = await createSession(ctx, userId);

    return {
      token,
      user: {
        _id: userId,
        username,
        createdAt: now,
      },
    };
  },
});

export const logIn = mutation({
  args: {
    username: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const username = normalizeUsername(args.username);
    const usernameLower = username.toLowerCase();

    const user = await ctx.db
      .query("users")
      .withIndex("by_usernameLower", (q) => q.eq("usernameLower", usernameLower))
      .unique();

    if (!user) {
      throw new Error("Invalid username or password.");
    }

    const computedHash = await hashPassword(args.password, user.passwordSalt);
    if (!hashesEqual(computedHash, user.passwordHash)) {
      throw new Error("Invalid username or password.");
    }

    const token = await createSession(ctx, user._id);
    return {
      token,
      user: {
        _id: user._id,
        username: user.username,
        createdAt: user.createdAt,
      },
    };
  },
});

export const currentUser = query({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    return lookupUserByToken(ctx.db, args.token);
  },
});

export const logout = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (token.length === 0) {
      return false;
    }

    const tokenHash = await sha256Hex(token);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    if (!session) {
      return false;
    }

    await ctx.db.delete(session._id);
    return true;
  },
});
