# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup        # First-time: install deps, generate Prisma client, run migrations
npm run dev          # Start dev server with Turbopack on http://localhost:3000
npm run build        # Production build
npm run lint         # ESLint
npm test             # Run all tests (Vitest)
npx vitest run src/lib/__tests__/file-system.test.ts  # Run a single test file
npm run db:reset     # Reset database (destructive)
```

## Architecture

UIGen is a Next.js 15 (App Router) app where users chat with Claude to generate React components that render in a live iframe preview. The core design uses a **virtual file system** — all file operations are in-memory only; nothing is written to disk.

### Request flow

1. User types a prompt in `ChatInterface` → POST to `/api/chat`
2. The API route streams Claude's response using Vercel AI SDK (`streamText`)
3. Claude calls tools (`str_replace_editor`, `file_manager`) to create/modify files
4. Tool results update the in-memory `VirtualFileSystem` via `FileSystemContext`
5. `PreviewFrame` receives updated files, transforms JSX with Babel standalone in the browser, builds an import map using esm.sh CDN, and renders in an iframe
6. If authenticated, the project (messages + serialized file system) is persisted to SQLite via Prisma

### Key files

| File | Purpose |
|------|---------|
| `src/app/api/chat/route.ts` | Main AI endpoint; orchestrates streaming, tool calls, and DB persistence |
| `src/lib/file-system.ts` | Virtual file system implementation (in-memory, no disk I/O) |
| `src/lib/contexts/file-system-context.tsx` | React context wrapping file system state |
| `src/lib/contexts/chat-context.tsx` | React context for messages and AI interaction |
| `src/lib/transform/jsx-transformer.ts` | Client-side Babel JSX transform + esm.sh import map builder |
| `src/components/preview/PreviewFrame.tsx` | iframe-based live preview renderer |
| `src/lib/tools/str-replace.ts` | Text editor tool exposed to Claude (view/create/str_replace/insert) |
| `src/lib/tools/file-manager.ts` | File rename/delete tool exposed to Claude |
| `src/lib/prompts/generation.tsx` | System prompt instructing Claude on how to generate components |
| `src/lib/provider.ts` | Returns real Anthropic model or mock provider (when no API key) |
| `src/lib/auth.ts` | JWT session management (jose, httpOnly cookie "auth-token") |
| `src/actions/index.ts` | Server actions for auth (signUp, signIn, signOut) |
| `prisma/schema.prisma` | SQLite schema: `User` and `Project` (messages + data as JSON strings) |

### Authentication

JWT-based with a 7-day "auth-token" httpOnly cookie. Anonymous use is supported — anonymous work is tracked in sessionStorage (`src/lib/anon-work-tracker.ts`) and can be claimed after sign-up.

### Database

SQLite via Prisma. The Prisma client is generated to `src/generated/prisma`. `Project.messages` and `Project.data` are JSON-stringified blobs (chat history and serialized virtual file system respectively).

### AI model

Defaults to `claude-haiku-4-5` via `@ai-sdk/anthropic`. When `ANTHROPIC_API_KEY` is absent, `src/lib/provider.ts` returns a mock that emits static responses. The chat API supports up to 40 tool-use steps per request.

### Preview iframe

`PreviewFrame` compiles JSX with `@babel/standalone` in the browser, detects third-party imports, builds an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) pointing to `esm.sh`, and writes everything into a blob URL loaded by the iframe. The entry point Claude is prompted to create is `/App.jsx` with Tailwind CSS for styling.

### Testing

Tests live alongside source in `__tests__` subdirectories. Vitest uses jsdom environment. Run individual files with `npx vitest run <path>`.
