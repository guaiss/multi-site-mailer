import { Badge, Code, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SitesResponse } from "../api";

interface Entry {
  id: string;
  site_id: string;
  status: string;
  from_address: string;
  to_address: string;
  template: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
}

const STATUS_COLOR: Record<string, string> = { sent: "green", failed: "red", pending: "yellow" };

export default function LogsPage() {
  const [site, setSite] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api<SitesResponse>("/sites") });
  const log = useQuery({
    queryKey: ["send-log", site, status],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (site) sp.set("site", site);
      if (status) sp.set("status", status);
      return api<{ entries: Entry[] }>(`/send-log?${sp}`);
    },
    refetchInterval: 30_000,
  });

  return (
    <Stack>
      <Title order={3}>Send log</Title>
      <Group>
        <Select placeholder="All sites" clearable data={(sites.data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))} value={site} onChange={setSite} />
        <Select
          placeholder="All statuses"
          clearable
          data={[
            { value: "sent", label: "Sent" },
            { value: "failed", label: "Failed" },
            { value: "pending", label: "Pending" },
          ]}
          value={status}
          onChange={setStatus}
        />
        <Text size="xs" c="dimmed">
          Latest 200 entries (UTC)
        </Text>
      </Group>
      <Table.ScrollContainer minWidth={900}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>Site</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>From → To</Table.Th>
              <Table.Th>Template</Table.Th>
              <Table.Th>Message-ID / error</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {log.data?.entries.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{e.created_at}</Table.Td>
                <Table.Td>{e.site_id}</Table.Td>
                <Table.Td>
                  <Badge color={STATUS_COLOR[e.status] ?? "gray"} variant="light">
                    {e.status}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{e.from_address}</Text>
                  <Text size="xs">→ {e.to_address}</Text>
                </Table.Td>
                <Table.Td>{e.template ?? "—"}</Table.Td>
                <Table.Td>
                  {e.error_code ? (
                    <Text size="xs" c="red">
                      {e.error_code}: {e.error_message}
                    </Text>
                  ) : (
                    <Code fz="xs">{e.provider_message_id}</Code>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
