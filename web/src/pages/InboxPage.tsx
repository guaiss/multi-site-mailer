import { Badge, Button, Card, Center, Group, Loader, SegmentedControl, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconPencil, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, fromNow, type ThreadSummary } from "../api";
import ComposeModal from "../components/ComposeModal";
import { useMailboxes } from "../components/MailboxNav";

const STATUSES = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const mailbox = params.get("mailbox") ?? "";
  const domain = params.get("domain") ?? "";
  const status = params.get("status") === "unread" ? "unread" : "all";
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

  const scopeLabel = mailbox
    ? mbData?.mailboxes.find((m) => m.id === mailbox)?.address
    : domain
      ? mbData?.mailboxes.find((m) => m.domain_id === domain)?.domain
      : "All inboxes";
  const items = threads.data?.pages.flatMap((p) => p.threads) ?? [];

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

      {threads.isPending ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : threads.error ? (
        <Text c="red">Failed to load: {threads.error.message}</Text>
      ) : items.length === 0 ? (
        <Center p="xl">
          <Text c="dimmed">No messages</Text>
        </Center>
      ) : (
        <Stack gap="xs">
          {items.map((t) => (
            <UnstyledButton key={t.id} onClick={() => navigate(`/inbox/t/${t.id}`)}>
              <Card withBorder padding="sm">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
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
