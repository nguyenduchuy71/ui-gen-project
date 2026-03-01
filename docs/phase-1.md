# UIGen — Phase 1 Documentation

> Trạng thái codebase sau khi hoàn thành Phase 1 (bug fix + code quality).
> Mục đích: tài liệu tham chiếu nhanh cho các phiên làm việc sau, tránh phải đọc lại toàn bộ source code.

---

## Tổng quan

UIGen là một web app cho phép user mô tả component React bằng ngôn ngữ tự nhiên trong chat, AI (Claude) tự động tạo code và hiển thị live preview trong iframe. Toàn bộ file chỉ tồn tại in-memory — không có I/O disk.

**Tech stack:** Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Prisma + SQLite · Vercel AI SDK · Anthropic Claude

---

## Kiến trúc tổng thể

```
User input (Chat)
    │
    ▼
ChatContext (useAIChat) ──► POST /api/chat
                                │
                        streamText (Claude)
                                │
                     Tool calls (str_replace_editor / file_manager)
                                │
                     VirtualFileSystem (in-memory)
                                │
                    FileSystemContext (refreshTrigger++)
                                │
                     PreviewFrame (useEffect)
                                │
                   Babel transform + esm.sh import map
                                │
                         iframe srcdoc
                                │
                    (if projectId) prisma.project.update
```

---

## Database (Prisma / SQLite)

**File:** `prisma/schema.prisma`
**Client output:** `src/generated/prisma`

```
User
  id        String  @id @default(cuid())
  email     String  @unique
  password  String  (bcrypt hash, 10 rounds)
  projects  Project[]
  createdAt / updatedAt

Project
  id        String  @id @default(cuid())
  name      String
  userId    String?  (nullable → anonymous projects)
  messages  String  @default("[]")   ← JSON.stringify(Message[])
  data      String  @default("{}")   ← JSON.stringify(Record<string, FileNode>)
  user      User?  @relation(onDelete: Cascade)
  createdAt / updatedAt
```

`Project.messages` và `Project.data` là JSON string. Khi đọc phải `JSON.parse()`, khi ghi phải `JSON.stringify()`.

---

## Authentication (`src/lib/auth.ts`)

JWT-based, không dùng NextAuth.

| Function | Mô tả |
|----------|-------|
| `createSession(userId, email)` | Tạo JWT HS256 7 ngày, set cookie `auth-token` httpOnly |
| `getSession()` | Đọc cookie → verify JWT → trả `SessionPayload \| null` |
| `deleteSession()` | Xóa cookie |
| `verifySession(request)` | Dùng trong middleware (nhận `NextRequest`) |

```typescript
interface SessionPayload {
  userId: string;
  email: string;
  expiresAt: Date;
}
```

**Lưu ý:** Secret key fallback `"development-secret-key"` nếu không có `JWT_SECRET` env — cần set khi deploy production.

**Middleware** (`src/middleware.ts`): chỉ bảo vệ `/api/projects` và `/api/filesystem`. Route `/api/chat` **không** được bảo vệ bởi middleware.

---

## Server Actions (`src/actions/`)

Tất cả đều là `"use server"`, tự động gọi `getSession()` để xác thực.

| Action | File | Mô tả |
|--------|------|-------|
| `signUp(email, password)` | `index.ts` | Validate → check duplicate email → bcrypt hash → tạo User → createSession |
| `signIn(email, password)` | `index.ts` | Tìm user → bcrypt.compare → createSession |
| `signOut()` | `index.ts` | deleteSession → redirect("/") |
| `getUser()` | `index.ts` | getSession → prisma.user.findUnique → trả `{id, email, createdAt}` |
| `createProject(input)` | `create-project.ts` | Yêu cầu session → prisma.project.create |
| `getProjects()` | `get-projects.ts` | Yêu cầu session → findMany orderBy updatedAt desc (chỉ trả id/name/dates) |
| `getProject(id)` | `get-project.ts` | Yêu cầu session → findUnique → JSON.parse messages + data |

`createProject` input shape:
```typescript
{ name: string; messages: any[]; data: Record<string, any> }
```

---

## VirtualFileSystem (`src/lib/file-system.ts`)

Class `VirtualFileSystem` — toàn bộ in-memory, không đụng disk.

**Cấu trúc nội bộ:**
- `this.files: Map<string, FileNode>` — flat lookup table theo path
- `this.root: FileNode` — node gốc `/`

```typescript
interface FileNode {
  type: "file" | "directory";
  name: string;       // tên file/thư mục (không có path)
  path: string;       // full path từ root
  content?: string;   // chỉ có với file
  children?: Map<string, FileNode>;  // chỉ có với directory
}
```

**Public API:**

| Method | Trả về | Mô tả |
|--------|--------|-------|
| `createFile(path, content?)` | `FileNode \| null` | Tạo file, tự tạo parent dirs |
| `createDirectory(path)` | `FileNode \| null` | Tạo thư mục |
| `readFile(path)` | `string \| null` | Đọc nội dung file |
| `updateFile(path, content)` | `boolean` | Cập nhật nội dung |
| `deleteFile(path)` | `boolean` | Xóa file/dir đệ quy |
| `rename(oldPath, newPath)` | `boolean` | Đổi tên/move, tự tạo parent dirs |
| `exists(path)` | `boolean` | Kiểm tra tồn tại |
| `getNode(path)` | `FileNode \| null` | Lấy node theo path |
| `listDirectory(path)` | `FileNode[] \| null` | Liệt kê con trực tiếp |
| `getAllFiles()` | `Map<string, string>` | Tất cả file → `{path: content}` |
| `serialize()` | `Record<string, FileNode>` | Serialize (bỏ Map children) |
| `deserialize(data)` | `void` | Từ `Record<string, string>` |
| `deserializeFromNodes(data)` | `void` | Từ `Record<string, FileNode>` |
| `reset()` | `void` | Xóa tất cả về trạng thái ban đầu |
| `viewFile(path, viewRange?)` | `string` | Text editor view command |
| `createFileWithParents(path, content?)` | `string` | Tạo file + parents, trả error string nếu lỗi |
| `replaceInFile(path, oldStr, newStr)` | `string` | str_replace trong file, trả error string nếu lỗi |
| `insertInFile(path, insertLine, text)` | `string` | Insert tại dòng, trả error string nếu lỗi |

**Private helper:** `ensureParentDirectories(filePath)` — tạo tất cả thư mục cha nếu chưa tồn tại. Dùng chung trong `createFile`, `createFileWithParents`, `rename`, `deserialize`, `deserializeFromNodes`.

**Singleton exported:** `export const fileSystem = new VirtualFileSystem()` — dùng cho testing, không dùng trong production (mỗi request tạo instance mới).

---

## AI Tools (`src/lib/tools/`)

Hai tool được đăng ký với Claude trong `/api/chat`:

### `str_replace_editor` (`str-replace.ts`)

```typescript
commands: "view" | "create" | "str_replace" | "insert" | "undo_edit"
params: { command, path, file_text?, insert_line?, new_str?, old_str?, view_range? }
```

- Gọi trực tiếp các method của `VirtualFileSystem`
- `undo_edit` → trả error (không hỗ trợ)
- Trả string mô tả kết quả

### `file_manager` (`file-manager.ts`)

```typescript
commands: "rename" | "delete"
params: { command, path, new_path? }
```

- Trả `{ success: boolean, message?: string, error?: string }`

---

## Chat API (`src/app/api/chat/route.ts`)

```
POST /api/chat
Body: { messages: Message[], files: Record<string, FileNode>, projectId?: string }
```

**Flow:**
1. Prepend system message (generationPrompt) vào đầu messages array (dùng spread, không mutate)
2. `fileSystem.deserializeFromNodes(files)` — reconstruct VFS từ client
3. `streamText()` với `maxTokens: 10_000`, `maxSteps: isMockProvider ? 4 : 40`
4. Trong `onFinish`: nếu có `projectId` → `getSession()` → `prisma.project.update` (messages + serialized VFS)
5. Trả `result.toDataStreamResponse()`

`maxDuration = 120` (Vercel timeout).

**Lưu ý quan trọng — Error handling:** `streamText` **không** dùng `onError` callback. Khi `onError` được cung cấp, Vercel AI SDK coi lỗi đã được xử lý và không forward xuống client. Không có `onError` → lỗi tự động propagate qua data stream protocol → `useAIChat` nhận được và set `error` state → UI hiển thị cho user.

---

## System Prompt (`src/lib/prompts/generation.tsx`)

Các quy tắc quan trọng Claude phải tuân theo:
- Luôn tạo `/App.jsx` làm entry point với default export
- Style bằng Tailwind CSS, không dùng hardcoded styles
- Không tạo HTML files
- Import local files bằng alias `@/` (ví dụ: `@/components/Button`)
- FS gốc là `/`, đây là virtual FS

---

## Language Model Provider (`src/lib/provider.ts`)

```typescript
export function getLanguageModel(): LanguageModelV1
```

- Nếu có `ANTHROPIC_API_KEY` → trả `anthropic("claude-haiku-4-5")`
- Nếu không → trả `MockLanguageModel` (static responses cho counter/form/card)

`MockLanguageModel` implements `LanguageModelV1` (Vercel AI SDK provider spec), hỗ trợ `doGenerate()` và `doStream()`.

---

## Contexts (`src/lib/contexts/`)

### FileSystemContext (`file-system-context.tsx`)

Wrap `VirtualFileSystem` với React state. **Điểm quan trọng:** `fileSystem` instance không bao giờ thay đổi (stable ref từ `useState` initializer).

```typescript
interface FileSystemContextType {
  fileSystem: VirtualFileSystem;
  selectedFile: string | null;
  setSelectedFile: (path: string | null) => void;
  createFile: (path: string, content?: string) => void;
  updateFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => boolean;
  getFileContent: (path: string) => string | null;
  getAllFiles: () => Map<string, string>;
  refreshTrigger: number;         // tăng +1 sau mỗi thao tác để trigger re-render
  handleToolCall: (toolCall: ToolCall) => void;
  reset: () => void;
}
```

**`handleToolCall`** xử lý tool calls từ AI stream:
- `str_replace_editor` → create / str_replace / insert: gọi method VFS tương ứng → `triggerRefresh()`
- `file_manager` → rename: gọi `renameFile()` (context wrapper) / delete: gọi `deleteFile()` (context wrapper)
- Tất cả mutations đều dùng VFS methods trực tiếp, không double-call

**Auto-select file:** `useEffect` theo dõi `refreshTrigger` — nếu `selectedFile` là null → tự chọn `/App.jsx` hoặc file root đầu tiên.

### ChatContext (`chat-context.tsx`)

Wrap `useAIChat` từ `@ai-sdk/react`.

```typescript
interface ChatContextType {
  messages: Message[];
  input: string;
  handleInputChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => void;
  status: string;
  error: Error | undefined;  // lỗi từ API (credit hết, network, v.v.)
}
```

`useAIChat` config:
- `api: "/api/chat"`
- `body: { files: fileSystem.serialize(), projectId }` — serialize VFS vào mỗi request
- `onToolCall: handleToolCall` — apply tool calls lên VFS ngay lập tức (optimistic)

Anonymous work tracking: `useEffect` theo dõi `messages` → `setHasAnonWork()` vào sessionStorage nếu không có `projectId`.

**Error display:** `ChatInterface` render banner đỏ khi `error` khác null. Lỗi "credit balance" được dịch thành thông báo tiếng Việt thân thiện; các lỗi khác hiển thị `error.message` gốc.

---

## Preview Pipeline (`src/components/preview/PreviewFrame.tsx` + `src/lib/transform/jsx-transformer.ts`)

**Trigger:** `refreshTrigger` thay đổi → `useEffect` chạy → `updatePreview()`

**Pipeline:**
```
getAllFiles()
    │
    ▼
createImportMap(files)                    ← jsx-transformer.ts
    │
    ├── Babel.transform(content) → JS code    (per file)
    ├── createBlobURL(jsCode)                  (per file)
    ├── Thêm vào import map: path, path sans slash, @/path, path sans ext (4 variations)
    ├── Detect third-party imports → esm.sh URL
    ├── Missing local imports → placeholder module (blob URL)
    └── Trả { importMap, styles, errors, blobUrls }
    │
    ▼
createPreviewHTML(entryPoint, importMap, styles, errors)
    │
    ├── Parse importMap → lấy blob URL cho entry point
    ├── Inject tailwind CDN script
    ├── Inject import map <script type="importmap">
    ├── Nếu có errors → hiển thị syntax error UI
    └── Nếu không có errors → <script type="module"> import App → ReactDOM.createRoot
    │
    ▼
iframe.srcdoc = previewHTML
```

**Memory management:** `prevBlobUrlsRef` lưu blob URLs của lần render trước. Mỗi lần render mới, revoke URLs cũ trước khi tạo mới (`URL.revokeObjectURL`).

**Entry point resolution** (theo thứ tự ưu tiên):
`/App.jsx` → `/App.tsx` → `/index.jsx` → `/index.tsx` → `/src/App.jsx` → `/src/App.tsx` → file .jsx/.tsx đầu tiên tìm thấy

**ImportMapResult interface:**
```typescript
interface ImportMapResult {
  importMap: string;   // JSON string
  styles: string;      // concatenated CSS content
  errors: Array<{ path: string; error: string }>;
  blobUrls: string[];  // tất cả blob URLs đã tạo (để revoke sau)
}
```

**`isThirdPartyPackage(importPath)`** helper:
```typescript
function isThirdPartyPackage(importPath: string): boolean {
  return !importPath.startsWith(".") &&
         !importPath.startsWith("/") &&
         !importPath.startsWith("@/");
}
```

---

## Anonymous Work Tracker (`src/lib/anon-work-tracker.ts`)

SessionStorage keys: `uigen_has_anon_work`, `uigen_anon_data`

```typescript
setHasAnonWork(messages, fileSystemData)  // lưu khi messages > 0
getHasAnonWork(): boolean
getAnonWorkData(): { messages, fileSystemData } | null
clearAnonWork()
```

Được gọi trong `ChatContext` khi không có `projectId`. Khi user sign in/up, `useAuth` hook kiểm tra và migrate anon work thành project.

---

## useAuth Hook (`src/hooks/use-auth.ts`)

Client-side hook xử lý post-login flow:

```
signIn/signUp
    │
    ▼ (success)
handlePostSignIn()
    ├── Có anon work? → createProject(anonWork) → clearAnonWork() → redirect(/:id)
    ├── Có projects? → redirect(/projects[0].id)
    └── Không có gì? → createProject("New Design #random") → redirect(/:id)
```

---

## Page Routes (`src/app/`)

| Route | File | Mô tả |
|-------|------|-------|
| `/` | `page.tsx` | Server component. Nếu authenticated → redirect đến project mới nhất. Nếu anonymous → render `<MainContent>` |
| `/[projectId]` | `[projectId]/page.tsx` | Server component. `getProject(id)` → render `<MainContent user project>` |

---

## MainContent Layout (`src/app/main-content.tsx`)

```
FileSystemProvider (initialData=project?.data)
  ChatProvider (projectId, initialMessages=project?.messages)
    ResizablePanelGroup horizontal
      ├── Panel 35% — ChatInterface
      └── Panel 65%
            ├── Header: Tabs (Preview/Code) + HeaderActions
            └── Content:
                  Preview mode → PreviewFrame
                  Code mode → ResizablePanelGroup
                                ├── Panel 30% — FileTree
                                └── Panel 70% — CodeEditor
```

**Props:**
```typescript
interface MainContentProps {
  user?: { id: string; email: string } | null;
  project?: {
    id: string; name: string;
    messages: any[]; data: any;
    createdAt: Date; updatedAt: Date;
  };
}
```

---

## Test Coverage

| File test | Tests | Phạm vi |
|-----------|-------|---------|
| `file-system.test.ts` | 60 | VirtualFileSystem toàn bộ public API |
| `jsx-transformer.test.ts` | 29 | transformJSX, createImportMap, createPreviewHTML |
| `file-system-context.test.tsx` | 25 | Context + handleToolCall (tất cả commands) |
| `chat-context.test.tsx` | 6 | ChatProvider, useChat |
| `ChatInterface.test.tsx` | 8 | ChatInterface component |
| `MessageList.test.tsx` | 13 | MessageList rendering |
| `MessageInput.test.tsx` | 15 | MessageInput interactions |
| `MarkdownRenderer.test.tsx` | 21 | Markdown rendering |
| `file-tree.test.tsx` | 8 | FileTree component |

Chạy: `npx vitest run` (tất cả) hoặc `npx vitest run <path>` (một file).

---

## Environment Variables

| Var | Required | Mô tả |
|-----|----------|-------|
| `ANTHROPIC_API_KEY` | Không | Nếu không có → dùng MockLanguageModel |
| `JWT_SECRET` | Production | Fallback: `"development-secret-key"` |

---

## Bugs đã fix trong Phase 1

| # | File | Vấn đề | Fix |
|---|------|---------|-----|
| 1 | `jsx-transformer.ts` | Memory leak: Blob URLs không bị revoke | Thêm `blobUrls[]` vào `ImportMapResult`, revoke trong PreviewFrame |
| 2 | `file-system-context.tsx` | Double-create: `createFileWithParents` + `createFile` | Thay `createFile()` bằng `triggerRefresh()` |
| 3 | `file-system-context.tsx` | Double-delete: `fileSystem.deleteFile` + `deleteFile()` | Bỏ direct call, chỉ gọi `deleteFile()` wrapper |
| 4 | `PreviewFrame.tsx` | `error` vừa là dep vừa set trong useEffect → double render | Bỏ `error` khỏi deps array |
| 5 | `PreviewFrame.tsx` | Magic string `"firstLoad"` trong error state | Dùng `isFirstLoad` state trực tiếp trong render |
| 6 | `jsx-transformer.ts` | Dead code: empty if-branch trong CSS processing | Đảo thành `if (!files.has(...))` |
| 7 | `route.ts` | `messages.unshift()` mutate input array | Dùng spread `[systemMsg, ...userMessages]` |
| 8 | `jsx-transformer.ts` | `isThirdPartyPackage` logic duplicate 2 chỗ | Extract thành helper function |
| 9 | `file-system.ts` | "tạo parent dirs" logic lặp 4+ chỗ | Extract `ensureParentDirectories()` private method |
| 10 | `file-system-context.tsx` | str_replace/insert: read-then-updateFile thừa | Thay bằng `triggerRefresh()` trực tiếp |
| 11 | `route.ts` + `chat-context.tsx` + `ChatInterface.tsx` | Lỗi API (hết credit, network…) bị nuốt im lặng — `onError: console.error` ngăn SDK forward lỗi xuống client, `error` từ `useAIChat` không được expose, UI không hiển thị gì | Bỏ `onError` khỏi `streamText`; thêm `error` vào `ChatContextType`; hiển thị error banner trong `ChatInterface` |

---

## Những gì Phase 1 CHƯA làm

- Không có refresh token / session renewal
- Không có rate limiting trên `/api/chat`
- MockLanguageModel chỉ nhận diện được 3 loại component (form/card/counter)
- `Project.name` không thể edit từ UI
- Không có export code ra file thực
- `serialize()` trong `chat-context.tsx` gọi mỗi message (O(n) files) — chấp nhận được với project nhỏ
- `JWT_SECRET` fallback không an toàn cho production
