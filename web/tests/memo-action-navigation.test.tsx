import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import toast from "react-hot-toast";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoActionHandlers } from "@/components/MemoActionMenu/hooks";
import { NewMemoProvider, useNewMemo } from "@/contexts/NewMemoContext";
import { State } from "@/types/proto/api/common_pb";
import { type Memo, Visibility } from "@/types/proto/api/memo_service_pb";

const mocks = vi.hoisted(() => ({
  createMemo: vi.fn(),
  updateMemo: vi.fn(),
  deleteMemo: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("copy-to-clipboard", () => ({ default: mocks.copy }));

vi.mock("@/hooks/useMemoQueries", () => ({
  memoKeys: {
    comments: (name: string) => ["memos", name, "comments"],
    detail: (name: string) => ["memos", name, "detail"],
  },
  useCreateMemo: () => ({ mutateAsync: mocks.createMemo }),
  useUpdateMemo: () => ({ mutateAsync: mocks.updateMemo }),
  useDeleteMemo: () => ({ mutateAsync: mocks.deleteMemo }),
}));

vi.mock("@/hooks/useUserQueries", () => ({
  userKeys: { stats: () => ["users", "stats"] },
}));

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({ profile: { instanceUrl: "" } }),
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string) => key,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const createMemo = (state: State, parent = ""): Memo =>
  ({
    name: "memos/1",
    creator: "users/alice",
    content: "memo",
    visibility: Visibility.PROTECTED,
    space: "spaces/work",
    state,
    parent,
  }) as Memo;

const renderActions = (state: State, parent = "", parentPage?: string) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/memos/1"]}>
        <NewMemoProvider>{children}</NewMemoProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const rendered = renderHook(
    () => {
      const location = useLocation();
      const handlers = useMemoActionHandlers({
        memo: createMemo(state, parent),
        parentPage,
        setDeleteDialogOpen: vi.fn(),
      });
      const { newMemoName } = useNewMemo();
      return { handlers, pathname: location.pathname, search: location.search, newMemoName };
    },
    { wrapper },
  );
  return { ...rendered, invalidateQueries };
};

describe("Memo detail mutation navigation", () => {
  beforeEach(() => {
    mocks.createMemo.mockReset().mockResolvedValue({ name: "memos/2" });
    mocks.updateMemo.mockReset().mockResolvedValue(undefined);
    mocks.deleteMemo.mockReset().mockResolvedValue(undefined);
    mocks.copy.mockReset();
  });

  it.each([
    [State.NORMAL, "/archived"],
    [State.ARCHIVED, "/"],
  ])("switches a %s memo to its user-level destination", async (state, destination) => {
    const { result } = renderActions(state);

    await act(async () => {
      await result.current.handlers.handleToggleMemoStatusClick();
    });

    await waitFor(() => expect(result.current.pathname).toBe(destination));
  });

  it("returns to the full Space origin after deleting a memo detail", async () => {
    const origin = "/spaces/product/calendar/2026/09/06?filter=tagSearch%3Awork";
    const { result } = renderActions(State.NORMAL, "", origin);
    await act(() => result.current.handlers.confirmDeleteMemo());
    expect(result.current.pathname + result.current.search).toBe(origin);
  });

  it("returns directly to a global origin after deleting", async () => {
    const { result } = renderActions(State.NORMAL);

    await act(async () => {
      await result.current.handlers.confirmDeleteMemo();
    });

    await waitFor(() => expect(result.current.pathname).toBe("/"));
  });

  it("refreshes a parent memo after deleting one of its comments", async () => {
    const { result, invalidateQueries } = renderActions(State.NORMAL, "memos/parent");

    await act(async () => {
      await result.current.handlers.confirmDeleteMemo();
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["memos", "memos/parent", "comments"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["memos", "memos/parent", "detail"] });
  });

  it.each([
    ["", "http://localhost:3000/memos/1"],
    ["memos/parent", "http://localhost:3000/memos/parent#1"],
  ])("copies a link that lands on the memo, or on the comment inside its parent (parent: %s)", (parent, link) => {
    const { result } = renderActions(State.NORMAL, parent);
    act(() => result.current.handlers.handleCopyLink());
    expect(mocks.copy).toHaveBeenCalledWith(link);
  });

  it("duplicates a memo's content, visibility and space into a new memo and puts it first", async () => {
    const { result, invalidateQueries } = renderActions(State.NORMAL);
    await act(() => result.current.handlers.handleDuplicateMemoClick());
    expect(mocks.createMemo).toHaveBeenCalledOnce();
    expect(mocks.createMemo.mock.calls[0][0].memo).toMatchObject({
      content: "memo",
      visibility: Visibility.PROTECTED,
      space: "spaces/work",
    });
    expect(mocks.createMemo.mock.calls[0][0].memo.name).toBe("");
    expect(mocks.updateMemo).not.toHaveBeenCalled();
    expect(result.current.newMemoName).toBe("memos/2");
    expect(toast.success).toHaveBeenCalledWith("message.duplicated-successfully");
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["memos", "memos/1", "detail"] });
  });

  it("reports a failed duplicate without marking a new memo", async () => {
    mocks.createMemo.mockRejectedValue(new Error("boom"));
    const { result } = renderActions(State.NORMAL);
    await act(() => result.current.handlers.handleDuplicateMemoClick());
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.newMemoName).toBeNull();
  });
});
