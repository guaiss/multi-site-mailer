import { Anchor, Badge, Box, Button, Card, Collapse, Group, Stack, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconAlertTriangle, IconDownload, IconPaperclip, IconPhoto } from "@tabler/icons-react";
import { useState } from "react";
import { fmtSize, fmtTime, type Message } from "../api";

function AuthBadge({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  const color = value === "pass" ? "green" : value === "none" || value === "neutral" ? "gray" : "red";
  return (
    <Badge size="xs" variant="light" color={color}>
      {label} {value}
    </Badge>
  );
}

const addrList = (xs: { addr: string; name?: string }[]) => xs.map((x) => (x.name ? `${x.name} <${x.addr}>` : x.addr)).join(", ");

function download(url: string, dangerous: boolean, name: string) {
  const go = () => window.open(url, "_blank", "noopener");
  if (!dangerous) return go();
  modals.openConfirmModal({
    title: "Potentially harmful attachment",
    children: <Text size="sm">"{name}" is an executable file type and may contain malware. Download anyway?</Text>,
    labels: { confirm: "Download anyway", cancel: "Cancel" },
    confirmProps: { color: "red" },
    onConfirm: go,
  });
}

export default function MessageCard({ m, defaultOpen }: { m: Message; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [images, setImages] = useState(false);
  const [tall, setTall] = useState(false);
  const inbound = m.direction === "in";
  const files = m.attachments.filter((a) => !(a.content_id && a.disposition === "inline"));

  return (
    <Card withBorder padding="sm">
      <Box onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} miw={0}>
            <Group gap="xs">
              <Text fw={600} truncate>
                {m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}
              </Text>
              <Badge size="xs" variant="light" color={inbound ? "blue" : "orange"}>
                {inbound ? "Received" : "Sent"}
              </Badge>
              {files.length > 0 && <IconPaperclip size={14} />}
            </Group>
            {open ? (
              <>
                <Text size="xs" c="dimmed">
                  To: {addrList(m.to)}
                </Text>
                {m.cc.length > 0 && (
                  <Text size="xs" c="dimmed">
                    Cc: {addrList(m.cc)}
                  </Text>
                )}
                {m.reply_to_addr && (
                  <Text size="xs" c="orange">
                    Reply-To: {m.reply_to_addr}
                  </Text>
                )}
                {m.sent_by && (
                  <Text size="xs" c="dimmed">
                    Sent by: {m.sent_by}
                  </Text>
                )}
              </>
            ) : (
              <Text size="sm" c="dimmed" lineClamp={1}>
                {m.text_body?.slice(0, 200)}
              </Text>
            )}
          </Stack>
          <Stack gap={4} align="flex-end">
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {fmtTime(m.sent_at)}
            </Text>
            {inbound && open && (
              <Group gap={4}>
                <AuthBadge label="SPF" value={m.auth_spf} />
                <AuthBadge label="DKIM" value={m.auth_dkim} />
                <AuthBadge label="DMARC" value={m.auth_dmarc} />
              </Group>
            )}
          </Stack>
        </Group>
      </Box>

      <Collapse expanded={open}>
        <Stack gap="xs" mt="sm">
          <Group gap="xs">
            {m.has_html === 1 && !images && (
              <Button size="compact-xs" variant="light" leftSection={<IconPhoto size={14} />} onClick={() => setImages(true)}>
                Show remote images
              </Button>
            )}
            {m.has_html === 1 && (
              <Button size="compact-xs" variant="subtle" onClick={() => setTall((t) => !t)}>
                {tall ? "Collapse" : "Expand"}
              </Button>
            )}
            {m.has_raw === 1 && (
              <Anchor size="xs" href={`/api/admin/messages/${m.id}/raw`}>
                Download original (.eml)
              </Anchor>
            )}
          </Group>
          {m.has_html === 1 ? (
            <iframe
              title={`message-${m.id}`}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              src={`/api/admin/messages/${m.id}/html${images ? "?images=1" : ""}`}
              style={{ width: "100%", height: tall ? 1200 : 480, border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, background: "white" }}
            />
          ) : (
            <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {m.text_body}
            </Text>
          )}
          {files.length > 0 && (
            <Group gap="xs">
              {files.map((a) => (
                <Tooltip key={a.id} label={a.content_type ?? ""}>
                  <Button
                    size="compact-sm"
                    variant="light"
                    color={a.is_executable ? "red" : undefined}
                    leftSection={a.is_executable ? <IconAlertTriangle size={14} /> : <IconDownload size={14} />}
                    onClick={() => download(`/api/admin/attachments/${a.id}`, a.is_executable === 1, a.filename ?? "attachment")}
                  >
                    {a.filename ?? "attachment"} · {fmtSize(a.size)}
                  </Button>
                </Tooltip>
              ))}
            </Group>
          )}
        </Stack>
      </Collapse>
    </Card>
  );
}
