import { Badge, Group, NavLink } from "@mantine/core";
import { IconAt, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { api, type Mailbox } from "../api";

export function useMailboxes() {
  return useQuery({ queryKey: ["mailboxes"], queryFn: () => api<{ mailboxes: Mailbox[] }>("/mailboxes"), refetchInterval: 60_000 });
}

export default function MailboxNav({ onNavigate }: { onNavigate: () => void }) {
  const { data } = useMailboxes();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const onInbox = pathname === "/inbox";

  const byDomain = new Map<string, { id: string; name: string; boxes: Mailbox[] }>();
  for (const m of data?.mailboxes ?? []) {
    const g = byDomain.get(m.domain_id) ?? { id: m.domain_id, name: m.domain, boxes: [] };
    g.boxes.push(m);
    byDomain.set(m.domain_id, g);
  }

  const go = (q: string) => {
    navigate(`/inbox?${q}`);
    onNavigate();
  };
  const unreadBadge = (n: number) =>
    n > 0 ? (
      <Badge size="xs" variant="filled" circle={n < 10}>
        {n}
      </Badge>
    ) : null;

  return (
    <>
      {[...byDomain.values()].map((d) => (
        <NavLink
          key={d.id}
          // NavLink with children owns rightSection (chevron), so the badge goes in the label.
          label={
            <Group gap={6} wrap="nowrap" justify="space-between">
              {d.name}
              {unreadBadge(d.boxes.reduce((s, b) => s + b.unread_count, 0))}
            </Group>
          }
          leftSection={<IconWorld size={16} />}
          active={onInbox && params.get("domain") === d.id}
          defaultOpened
          childrenOffset={20}
          onClick={() => go(`domain=${d.id}`)}
        >
          {d.boxes.map((b) => (
            <NavLink
              key={b.id}
              label={b.local_part}
              leftSection={<IconAt size={14} />}
              rightSection={unreadBadge(b.unread_count)}
              active={onInbox && params.get("mailbox") === b.id}
              onClick={() => go(`mailbox=${b.id}`)}
            />
          ))}
        </NavLink>
      ))}
    </>
  );
}
