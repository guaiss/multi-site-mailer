import { Button, Group, Modal, Select, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { AttachmentPicker, buildOutgoing, MailEditor, useMailEditor } from "./Editor";
import { useMailboxes } from "./MailboxNav";

export default function ComposeModal({ opened, onClose, defaultMailbox }: { opened: boolean; onClose: () => void; defaultMailbox?: string }) {
  const { data } = useMailboxes();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const editor = useMailEditor();
  const [mailboxId, setMailboxId] = useState<string | null>(defaultMailbox || null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    if (opened && defaultMailbox) setMailboxId(defaultMailbox);
  }, [opened, defaultMailbox]);

  const send = useMutation({
    mutationFn: async () => {
      if (!mailboxId) throw new Error("Choose a sending mailbox");
      if (!to.trim()) throw new Error("Recipient is required");
      if (!subject.trim()) throw new Error("Subject is required");
      const body = await buildOutgoing(editor, files);
      return api<{ thread_id: string }>("/compose", { body: { mailbox_id: mailboxId, to: to.trim(), subject: subject.trim(), ...body } });
    },
    onSuccess: (r) => {
      notifications.show({ color: "green", message: "Sent" });
      qc.invalidateQueries({ queryKey: ["threads"] });
      editor?.commands.clearContent();
      setTo("");
      setSubject("");
      setFiles([]);
      onClose();
      navigate(`/inbox/t/${r.thread_id}`);
    },
    onError: (e) => notifications.show({ color: "red", title: "Send failed", message: e.message }),
  });

  return (
    <Modal opened={opened} onClose={onClose} title="New message" size="xl">
      <Stack>
        <Select
          label="From mailbox"
          data={(data?.mailboxes ?? []).map((m) => ({ value: m.id, label: m.address }))}
          value={mailboxId}
          onChange={setMailboxId}
          searchable
        />
        <TextInput label="To" placeholder="name@example.com" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.currentTarget.value)} />
        <MailEditor editor={editor} />
        <AttachmentPicker files={files} onChange={setFiles} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={send.isPending} onClick={() => send.mutate()}>
            Send
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
