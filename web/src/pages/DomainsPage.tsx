import { ActionIcon, Alert, Badge, Button, Checkbox, Code, CopyButton, Group, Loader, Modal, Stack, Table, TagsInput, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api, type Domain, type Mailbox } from "../api";
import DomainSendingDrawer from "../components/DomainSendingDrawer";
import { useMailboxes } from "../components/MailboxNav";

interface DomainCheck {
  domain: string;
  nameservers: string[];
  on_cloudflare: boolean;
  mx: string[];
  existing_mail: string[];
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// Warns before onboarding a domain that isn't on Cloudflare or already receives mail elsewhere.
function DomainCheckNotice({ name, onBlocking }: { name: string; onBlocking: (blocking: boolean) => void }) {
  const [debounced] = useDebouncedValue(name.trim().toLowerCase(), 400);
  const [ack, setAck] = useState(false);
  const valid = DOMAIN_RE.test(debounced);
  const check = useQuery({
    queryKey: ["domain-check", debounced],
    queryFn: () => api<DomainCheck>(`/domains/check?name=${encodeURIComponent(debounced)}`),
    enabled: valid,
    staleTime: 60_000,
  });
  const c = check.data;
  const blocking = !valid || !c || (c.existing_mail.length > 0 && !ack);
  useEffect(() => onBlocking(blocking), [blocking, onBlocking]);
  useEffect(() => setAck(false), [debounced]);

  if (!valid) return null;
  if (check.isLoading) return <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">Checking DNS…</Text></Group>;
  if (check.isError)
    return (
      <Alert color="orange" variant="light" title="DNS check failed">
        <Button size="compact-xs" variant="light" onClick={() => check.refetch()}>
          Check again
        </Button>
      </Alert>
    );
  if (!c) return null;
  return (
    <Stack gap="xs">
      {c.on_cloudflare ? (
        <Alert color="green" variant="light">DNS is on Cloudflare ({c.nameservers.join(", ")}).</Alert>
      ) : (
        <Alert color="orange" variant="light" title="DNS is not on Cloudflare">
          Nameservers: {c.nameservers.join(", ") || "none found"}. Email Sending/Routing need the domain's DNS on this Cloudflare account; move it here
          before running the onboard script.
        </Alert>
      )}
      {c.existing_mail.length > 0 && (
        <Alert color="red" variant="light" title="This domain already receives mail">
          <Text size="sm" mb="xs">
            MX: {c.existing_mail.join(", ")}. Onboarding replaces the MX records, so that mailbox provider would stop receiving mail for this domain.
          </Text>
          <Checkbox size="xs" label="I understand; this domain's existing mail service is not in use" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} />
        </Alert>
      )}
    </Stack>
  );
}

const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });

function Cmd({ cmd }: { cmd: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Code>{cmd}</Code>
      <CopyButton value={cmd}>
        {({ copied, copy }) => (
          <ActionIcon size="sm" variant="subtle" onClick={copy} color={copied ? "green" : undefined}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Group>
  );
}

export default function DomainsPage() {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const { data: mb } = useMailboxes();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["domains"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const [sendingId, setSendingId] = useState<string | null>(null);
  const sendingDomain = domains.data?.domains.find((d) => d.id === sendingId);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [locals, setLocals] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(true);
  const onBlocking = useCallback((b: boolean) => setBlocking(b), []);
  const [boxFor, setBoxFor] = useState<Domain | null>(null);
  const [local, setLocal] = useState("");
  const [boxName, setBoxName] = useState("");
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [editName, setEditName] = useState("");

  const addDomain = useMutation({
    mutationFn: () => api("/domains", { body: { name: name.trim().toLowerCase(), mailboxes: locals } }),
    onSuccess: () => {
      invalidate();
      setCreated(name.trim().toLowerCase());
      setAddOpen(false);
      setName("");
      setLocals([]);
    },
    onError,
  });
  const addBox = useMutation({
    mutationFn: () => api("/mailboxes", { body: { domain_id: boxFor!.id, local_part: local.trim(), display_name: boxName.trim() } }),
    onSuccess: () => {
      invalidate();
      setBoxFor(null);
      setLocal("");
      setBoxName("");
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (path: string) => api(path, { method: "DELETE" }),
    onSuccess: () => invalidate(),
    onError,
  });
  const confirmDelete = (label: string, path: string) =>
    modals.openConfirmModal({
      title: `Delete ${label}?`,
      children: (
        <Text size="sm">
          Only possible while it has no mail. Cloudflare routing rules are not removed automatically; delete them in the Cloudflare dashboard if needed.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => del.mutate(path),
    });

  const rename = useMutation({
    mutationFn: () => api(`/mailboxes/${editing!.id}`, { method: "PATCH", body: { display_name: editName.trim() || null } }),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
    onError,
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Domains</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
          Add domain
        </Button>
      </Group>
      <Alert variant="light" title="Cloudflare setup">
        <Text size="sm" mb="xs">
          Manage receiving mailboxes, allowed senders, quotas and templates here. Cloudflare DNS setup is separate; the command below uses only the mailboxes you have configured:
        </Text>
        <Cmd cmd={`node scripts/onboard-domain.mjs ${created ?? "<domain>"}`} />
      </Alert>
      {created && (
        <Alert color="green" withCloseButton onClose={() => setCreated(null)}>
          Registered {created}. Run the command above to finish the Cloudflare setup; until then it can neither receive nor send mail.
        </Alert>
      )}
      <Table.ScrollContainer minWidth={900}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Domain</Table.Th>
              <Table.Th>Mailboxes</Table.Th>
              <Table.Th>API sending</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {domains.data?.domains.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td valign="top">
                  <Text fw={500}>{d.name}</Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap={4}>
                    {mb?.mailboxes
                      .filter((m) => m.domain_id === d.id)
                      .map((m) => (
                        <Group key={m.id} gap="xs">
                          <Text size="sm">{m.address}</Text>
                          <Text size="xs" c="dimmed">
                            {m.display_name ? `Display name: ${m.display_name}` : ""}
                          </Text>
                          <Tooltip label="Edit display name">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              onClick={() => {
                                setEditing(m);
                                setEditName(m.display_name ?? "");
                              }}
                            >
                              <IconEdit size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete mailbox">
                            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => confirmDelete(m.address, `/mailboxes/${m.id}`)}>
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      ))}
                  </Stack>
                </Table.Td>
                <Table.Td valign="top">
                  <Stack gap={4}>
                    <Badge size="sm" color={d.status === "active" ? "green" : "gray"}>{d.status === "active" ? "Allowed" : "Disabled"}</Badge>
                    <Text size="xs" c="dimmed">{d.sent_today} sent today · quota {d.daily_quota}</Text>
                    <Text size="xs" c="dimmed">{d.senders.length} allowed sender(s)</Text>
                  </Stack>
                </Table.Td>
                <Table.Td valign="top">
                  <Group gap="xs" wrap="nowrap">
                    <Button size="compact-sm" variant="light" onClick={() => setSendingId(d.id)}>Sending settings</Button>
                    <Button size="compact-sm" variant="light" onClick={() => setBoxFor(d)}>
                      Add mailbox
                    </Button>
                    <Tooltip label="Delete domain">
                      <ActionIcon variant="subtle" color="red" onClick={() => confirmDelete(d.name, `/domains/${d.id}`)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      {sendingDomain && <DomainSendingDrawer key={sendingDomain.id} domain={sendingDomain} onClose={() => setSendingId(null)} />}
      {domains.error && <Alert color="red">{domains.error.message}</Alert>}
      <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Add domain">
        <Stack>
          <TextInput label="Domain" placeholder="example.com" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <DomainCheckNotice name={name} onBlocking={onBlocking} />
          <TagsInput label="Initial mailboxes" description="Optional. Enter only the mailbox names you want to create." value={locals} onChange={setLocals} />
          <Button loading={addDomain.isPending} disabled={blocking} onClick={() => addDomain.mutate()}>
            Add
          </Button>
        </Stack>
      </Modal>
      <Modal opened={!!boxFor} onClose={() => setBoxFor(null)} title={`Add mailbox @${boxFor?.name ?? ""}`}>
        <Stack>
          <TextInput label="Mailbox name" placeholder="support" value={local} onChange={(e) => setLocal(e.currentTarget.value)} />
          <TextInput label="Display name (optional)" placeholder="Example Support" value={boxName} onChange={(e) => setBoxName(e.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            After adding, re-run the onboard script to create the routing rule for the new address.
          </Text>
          <Button loading={addBox.isPending} onClick={() => addBox.mutate()}>
            Add
          </Button>
        </Stack>
      </Modal>
      <Modal opened={!!editing} onClose={() => setEditing(null)} title={editing?.address}>
        <Stack>
          <TextInput label="Display name" description="Used as the sender name on replies" value={editName} onChange={(e) => setEditName(e.currentTarget.value)} />
          <Button loading={rename.isPending} onClick={() => rename.mutate()}>
            Save
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
