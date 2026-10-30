import { ActionIcon, Badge, Button, Card, Center, Group, Loader, Stack, TagsInput, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconArrowBackUp, IconArrowLeft, IconMail, IconSend, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, type ThreadDetail } from "../api";
import { AttachmentPicker, buildOutgoing, MailEditor, useMailEditor } from "../components/Editor";
import MessageCard from "../components/MessageCard";

export default function ThreadPage() {
  const { threadId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editor = useMailEditor();
  const [cc, setCc] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const markedRef = useRef<string | null>(null);

  const detail = useQuery({ queryKey: ["thread", threadId], queryFn: () => api<ThreadDetail>(`/threads/${threadId}`) });

  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: ["threads"] });
    qc.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const bulk = useMutation({
    mutationFn: (action: "delete" | "restore" | "purge") => api(`/threads/bulk`, { body: { ids: [threadId], action } }),
    onSuccess: (_r, action) => {
      refreshLists();
      if (action === "restore") qc.invalidateQueries({ queryKey: ["thread", threadId] });
      else navigate(-1);
      notifications.show({ message: action === "delete" ? "Moved to Trash" : action === "restore" ? "Restored" : "Deleted forever" });
    },
    onError: (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message }),
  });

  const markRead = useMutation({
    mutationFn: (read: boolean) => api(`/threads/${threadId}/read`, { body: { read } }),
    onSuccess: refreshLists,
  });

  useEffect(() => {
    if (detail.data && detail.data.thread.unread_count > 0 && markedRef.current !== threadId) {
      markedRef.current = threadId;
      markRead.mutate(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, threadId]);

  const reply = useMutation({
    mutationFn: async () => api(`/threads/${threadId}/reply`, { body: { ...(await buildOutgoing(editor, files)), cc } }),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Reply sent" });
      editor?.commands.clearContent();
      setFiles([]);
      setCc([]);
      qc.invalidateQueries({ queryKey: ["thread", threadId] });
      refreshLists();
    },
    onError: (e) => notifications.show({ color: "red", title: "Send failed", message: e.message }),
  });

  if (detail.isPending)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (detail.error) return <Text c="red">Failed to load: {detail.error.message}</Text>;

  const { thread, messages } = detail.data;

  return (
    <Stack maw={960}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="xs" wrap="nowrap" miw={0}>
          <ActionIcon variant="subtle" onClick={() => navigate(-1)} aria-label="Back">
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Stack gap={2} miw={0}>
            <Title order={4} lineClamp={2}>
              {thread.subject}
            </Title>
            <Group gap="xs">
              <Badge variant="light" color="gray">
                {thread.mailbox_address}
              </Badge>
              {thread.deleted_at && (
                <Badge variant="light" color="red">
                  In Trash
                </Badge>
              )}
            </Group>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" leftSection={<IconMail size={14} />} onClick={() => markRead.mutate(false)}>
            Mark unread
          </Button>
          {thread.deleted_at ? (
            <>
              <Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} loading={bulk.isPending} onClick={() => bulk.mutate("restore")}>
                Restore
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={() =>
                  modals.openConfirmModal({
                    title: "Delete forever?",
                    children: <Text size="sm">This permanently deletes the conversation, its original emails and attachments.</Text>,
                    labels: { confirm: "Delete forever", cancel: "Cancel" },
                    confirmProps: { color: "red" },
                    onConfirm: () => bulk.mutate("purge"),
                  })
                }
              >
                Delete forever
              </Button>
            </>
          ) : (
            <Button size="xs" color="red" variant="light" leftSection={<IconTrash size={14} />} loading={bulk.isPending} onClick={() => bulk.mutate("delete")}>
              Delete
            </Button>
          )}
        </Group>
      </Group>

      {messages.map((m, i) => (
        <MessageCard key={m.id} m={m} defaultOpen={i === messages.length - 1} />
      ))}

      <Card withBorder>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            From: {thread.mailbox_display_name ? `${thread.mailbox_display_name} <${thread.mailbox_address}>` : thread.mailbox_address}
          </Text>
          <TagsInput label="Cc" placeholder="Type an address and press Enter" value={cc} onChange={setCc} />
          <MailEditor editor={editor} />
          <AttachmentPicker files={files} onChange={setFiles} />
          <Group justify="flex-end">
            <Button leftSection={<IconSend size={16} />} loading={reply.isPending} onClick={() => reply.mutate()}>
              Reply
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
