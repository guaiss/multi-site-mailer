import { Code, Stack, Table, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api, fmtTime } from "../api";

interface Entry {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  at: number;
}

export default function AuditPage() {
  const { data } = useQuery({ queryKey: ["audit"], queryFn: () => api<{ entries: Entry[] }>("/audit") });
  return (
    <Stack>
      <Title order={3}>Audit log</Title>
      <Table.ScrollContainer minWidth={700}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>Actor</Table.Th>
              <Table.Th>Action</Table.Th>
              <Table.Th>Target</Table.Th>
              <Table.Th>Detail</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data?.entries.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.at)}</Table.Td>
                <Table.Td>{e.actor}</Table.Td>
                <Table.Td>
                  <Code>{e.action}</Code>
                </Table.Td>
                <Table.Td>{e.target}</Table.Td>
                <Table.Td>{e.detail && <Code fz="xs">{e.detail}</Code>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
