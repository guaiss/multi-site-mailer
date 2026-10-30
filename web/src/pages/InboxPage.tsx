import { Badge, Button, Card, Center, Checkbox, Group, Loader, Paper, SegmentedControl, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconArrowBackUp, IconMail, IconMailOpened, IconPencil, IconSearch, IconTrash, IconTrashX } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, fromNow, type ThreadSummary } from "../api";
import ComposeModal from "../components/ComposeModal";
import { useMailboxes } from "../components/MailboxNav";

const STATUSES = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "trash", label: "Trash" },
];

type BulkAction = "delete" | "restore" | "read" | "unread" | "purge";
const DONE_MESSAGE: Record<BulkAction, string> = {
  delete: "moved to Trash",
  restore: "restored",
  read: "marked read",
  unread: "marked unread",
  purge: "deleted forever",
};

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const mailbox = params.get("mailbox") ?? "";
  const domain = params.get("domain") ?? "";
  const rawStatus = params.get("status");
  const status = rawStatus === "unread" || rawStatus === "trash" ? rawStatus : "all";
  const inTrash = status === "trash";
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const [composeOpen, setComposeOpen] = useState(false);
  const { data: mbData } = useMailboxes();

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  const threads = useInfiniteQuery({
    queryKey: ["threads", { mailbox, domain, status, q }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ status });
      if (mailbox) sp.set("mailbox", mailbox);
      if (domain) sp.set("domain", domain);
      if (q) sp.set("q", q);
      if (pageParam) sp.set("before", String(pageParam));
      return api<{ threads: ThreadSummary[]; next_before: number | null }>(`/threads?${sp}`);
    },
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: 60_000,
  });

  // Selection is per view; switching filter/scope/search clears it.
  useEffect(() => setSelected(new Set()), [mailbox, domain, status, q]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["threads"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };
  const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });
  const bulk = useMutation({
    mutationFn: (v: { action: BulkAction; ids: string[] }) => api<{ affected: number }>("/threads/bulk", { body: v }),
    onSuccess: (r, v) => {
      setSelected(new Set());
      refresh();
      notifications.show({ message: `${r.affected} conversation${r.affected === 1 ? "" : "s"} ${DONE_MESSAGE[v.action]}` });
    },
    onError,
  });
  const emptyTrash = useMutation({
    mutationFn: () => api<{ affected: number }>("/trash/empty", { method: "POST" }),
    onSuccess: (r) => {
      setSelected(new Set());
      refresh();
      notifications.show({ message: `Trash emptied (${r.affected})` });
    },
    onError,
  });
  const run = (action: BulkAction) => bulk.mutate({ action, ids: [...selected] });
  const confirmPurge = (onConfirm: () => void, what: string) =>
    modals.openConfirmModal({
      title: "Delete forever?",
      children: <Text size="sm">This permanently deletes {what}, including original emails and attachments. It can't be undone.</Text>,
      labels: { confirm: "Delete forever", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm,
    });

  const scopeLabel = mailbox
    ? mbData?.mailboxes.find((m) => m.id === mailbox)?.address
    : domain
      ? mbData?.mailboxes.find((m) => m.domain_id === domain)?.domain
      : "All inboxes";
  const items = threads.data?.pages.flatMap((p) => p.threads) ?? [];
  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const someSelected = selected.size > 0;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Stack>
      <Group justify="space-between">
        <Text fw={600} size="lg">
          {scopeLabel}
        </Text>
        <Button leftSection={<IconPencil size={16} />} onClick={() => setComposeOpen(true)}>
          Compose
        </Button>
      </Group>
      <Group>
        <SegmentedControl data={STATUSES} value={status} onChange={(v) => setParam("status", v === "all" ? "" : v)} />
        <TextInput
          flex={1}
          miw={200}
          placeholder="Search subject, sender, body (Enter)"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && setParam("q", search.trim())}
        />
      </Group>

      {items.length > 0 && (
        <Paper withBorder px="sm" py={6}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Checkbox
              label={someSelected ? `${selected.size} selected` : "Select all"}
              checked={allSelected}
              indeterminate={someSelected && !allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((t) => t.id)))}
            />
            <Group gap="xs">
              {someSelected && !inTrash && (
                <>
                  <Button size="compact-sm" variant="default" leftSection={<IconMailOpened size={14} />} onClick={() => run("read")} loading={bulk.isPending}>
                    Mark read
                  </Button>
                  <Button size="compact-sm" variant="default" leftSection={<IconMail size={14} />} onClick={() => run("unread")} loading={bulk.isPending}>
                    Mark unread
                  </Button>
                  <Button size="compact-sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => run("delete")} loading={bulk.isPending}>
                    Delete
                  </Button>
                </>
              )}
              {someSelected && inTrash && (
                <>
                  <Button size="compact-sm" variant="default" leftSection={<IconArrowBackUp size={14} />} onClick={() => run("restore")} loading={bulk.isPending}>
                    Restore
                  </Button>
                  <Button
                    size="compact-sm"
                    color="red"
                    variant="light"
                    leftSection={<IconTrashX size={14} />}
                    loading={bulk.isPending}
                    onClick={() => confirmPurge(() => run("purge"), `${selected.size} conversation${selected.size === 1 ? "" : "s"}`)}
                  >
                    Delete forever
                  </Button>
                </>
              )}
              {inTrash && !someSelected && (
                <Button
                  size="compact-sm"
                  color="red"
                  variant="subtle"
                  leftSection={<IconTrashX size={14} />}
                  loading={emptyTrash.isPending}
                  onClick={() => confirmPurge(() => emptyTrash.mutate(), "everything in Trash")}
                >
                  Empty trash
                </Button>
              )}
            </Group>
          </Group>
        </Paper>
      )}
      {inTrash && (
        <Text size="xs" c="dimmed">
          Conversations in Trash are deleted forever after 30 days. A new reply from the customer moves a conversation back to the inbox.
        </Text>
      )}

      {threads.isPending ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : threads.error ? (
        <Text c="red">Failed to load: {threads.error.message}</Text>
      ) : items.length === 0 ? (
        <Center p="xl">
          <Text c="dimmed">{inTrash ? "Trash is empty" : "No messages"}</Text>
        </Center>
      ) : (
        <Stack gap="xs">
          {items.map((t) => (
            <UnstyledButton key={t.id} onClick={() => navigate(`/inbox/t/${t.id}`)}>
              <Card withBorder padding="sm" bg={selected.has(t.id) ? "var(--mantine-primary-color-light)" : undefined}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Checkbox
                    mt={2}
                    aria-label="Select conversation"
                    checked={selected.has(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(t.id)}
                  />
                  <Stack gap={2} miw={0} flex={1}>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={t.unread_count > 0 ? 700 : 400} truncate>
                        {t.counterpart ?? "(unknown)"}
                      </Text>
                      {t.message_count > 1 && (
                        <Text size="xs" c="dimmed">
                          ({t.message_count})
                        </Text>
                      )}
                    </Group>
                    <Text fw={t.unread_count > 0 ? 700 : 500} size="sm" truncate>
                      {t.subject}
                    </Text>
                    <Text size="sm" c="dimmed" lineClamp={1}>
                      {t.snippet}
                    </Text>
                  </Stack>
                  <Stack gap={4} align="flex-end">
                    <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      {fromNow(t.last_message_at)}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {t.mailbox_address}
                    </Badge>
                  </Stack>
                </Group>
              </Card>
            </UnstyledButton>
          ))}
          {threads.hasNextPage && (
            <Button variant="subtle" loading={threads.isFetchingNextPage} onClick={() => threads.fetchNextPage()}>
              Load more
            </Button>
          )}
        </Stack>
      )}
      <ComposeModal opened={composeOpen} onClose={() => setComposeOpen(false)} defaultMailbox={mailbox} />
    </Stack>
  );
}
