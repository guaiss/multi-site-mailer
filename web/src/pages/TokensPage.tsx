import { Alert, Anchor, Badge, Button, Code, CopyButton, Group, Modal, MultiSelect, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Domain } from "../api";
import SecretField from "../components/SecretField";

interface ReadToken {
  id: string;
  name: string;
  key_prefix: string;
  key_plain: string | null;
  allowed_domains: string[] | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });

export default function TokensPage() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["read-tokens"], queryFn: () => api<{ tokens: ReadToken[] }>("/read-tokens") });
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const domainName = (id: string) => domains.data?.domains.find((d) => d.id === id)?.name ?? id;

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<{ id: string; key: string }>("/read-tokens", { body: { name, allowed_domains: scope.length ? scope : null } }),
    onSuccess: (r) => {
      setCreateOpen(false);
      setName("");
      setScope([]);
      setNewKey(r.key);
      qc.invalidateQueries({ queryKey: ["read-tokens"] });
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/read-tokens/${id}/revoke`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["read-tokens"] }),
    onError,
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>API tokens</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
          New read token
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Read-only tokens let scripts and AI agents fetch stored mail (e.g. a daily summary) via{" "}
        <Code>GET {window.location.origin}/api/v1/mail/messages</Code>. They cannot send or modify anything. Give your agent the guide at{" "}
        <Anchor href={`${window.location.origin}/api/v1/llms-mail.txt`} target="_blank" rel="noreferrer">
          {window.location.host}/api/v1/llms-mail.txt
        </Anchor>
        .
      </Text>

      {tokens.error && <Alert color="red">{(tokens.error as Error).message}</Alert>}
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Token</Table.Th>
            <Table.Th>Domains</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Last used</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tokens.data?.tokens.map((t) => (
            <Table.Tr key={t.id} style={t.revoked_at ? { opacity: 0.5 } : undefined}>
              <Table.Td>{t.name}</Table.Td>
              <Table.Td>
                <SecretField value={t.key_plain} prefix={t.key_prefix} />
              </Table.Td>
              <Table.Td>
                {t.allowed_domains ? (
                  <Group gap={4}>
                    {t.allowed_domains.map((d) => (
                      <Badge key={d} size="sm" variant="light">
                        {domainName(d)}
                      </Badge>
                    ))}
                  </Group>
                ) : (
                  <Badge size="sm" variant="light" color="gray">
                    All domains
                  </Badge>
                )}
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{t.created_at} UTC</Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>{t.last_used_at ? `${t.last_used_at} UTC` : "Never"}</Table.Td>
              <Table.Td>
                {t.revoked_at ? (
                  <Badge color="red" variant="light">
                    Revoked
                  </Badge>
                ) : (
                  <Button
                    size="compact-xs"
                    color="red"
                    variant="subtle"
                    onClick={() =>
                      modals.openConfirmModal({
                        title: "Revoke token",
                        children: <Text size="sm">Anything using “{t.name}” will stop working immediately.</Text>,
                        labels: { confirm: "Revoke", cancel: "Cancel" },
                        confirmProps: { color: "red" },
                        onConfirm: () => revoke.mutate(t.id),
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
          {tokens.data?.tokens.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text size="sm" c="dimmed" ta="center">
                  No tokens yet
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New read token">
        <Stack>
          <TextInput label="Name" placeholder="Daily summary agent" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
          <MultiSelect
            label="Limit to domains"
            description="Leave empty to allow all domains"
            data={(domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))}
            value={scope}
            onChange={setScope}
            clearable
            searchable
          />
          <Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create
          </Button>
        </Stack>
      </Modal>

      <Modal opened={!!newKey} onClose={() => setNewKey(null)} title="New read token" closeOnClickOutside={false}>
        <Stack>
          <Alert color="orange">
            This token can read customer mail. Store it as a secret (e.g. <Code>MAILER_READ_TOKEN</Code>). You can view it again later in the
            tokens table.
          </Alert>
          <Code block>{newKey}</Code>
          <CopyButton value={newKey ?? ""}>
            {({ copied, copy }) => (
              <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} color={copied ? "green" : undefined} onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </CopyButton>
        </Stack>
      </Modal>
    </Stack>
  );
}
