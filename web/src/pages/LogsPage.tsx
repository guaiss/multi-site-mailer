import { Badge, Code, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Domain } from "../api";

interface Entry {
  id: string;
  domain_id: string;
  domain: string | null;
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
  const [domain, setDomain] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const log = useQuery({
    queryKey: ["send-log", domain, status],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (domain) sp.set("domain", domain);
      if (status) sp.set("status", status);
      return api<{ entries: Entry[] }>(`/send-log?${sp}`);
    },
    refetchInterval: 30_000,
  });

  return (
    <Stack>
      <Title order={3}>Send log</Title>
      <Group>
        <Select placeholder="All domains" clearable data={(domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))} value={domain} onChange={setDomain} />
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
              <Table.Th>Domain</Table.Th>
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
                <Table.Td>{e.domain ?? e.from_address.split("@")[1]}</Table.Td>
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
