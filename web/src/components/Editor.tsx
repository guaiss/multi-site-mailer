import { Group, Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { IconPaperclip } from "@tabler/icons-react";
import { useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Badge, CloseButton } from "@mantine/core";
import { fileToBase64, fmtSize, MAX_SEND_BYTES, type OutAttachment } from "../api";

export function useMailEditor() {
  return useEditor({
    extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false })],
    content: "",
  });
}

export function MailEditor({ editor }: { editor: Editor | null }) {
  return (
    <RichTextEditor editor={editor}>
      <RichTextEditor.Toolbar>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Bold />
          <RichTextEditor.Italic />
          <RichTextEditor.Strikethrough />
          <RichTextEditor.ClearFormatting />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.BulletList />
          <RichTextEditor.OrderedList />
          <RichTextEditor.Blockquote />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Link />
          <RichTextEditor.Unlink />
        </RichTextEditor.ControlsGroup>
      </RichTextEditor.Toolbar>
      <RichTextEditor.Content mih={160} />
    </RichTextEditor>
  );
}

export function AttachmentPicker({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  return (
    <Stack gap={6}>
      <Dropzone onDrop={(f) => onChange([...files, ...f])} maxSize={5 * 1024 * 1024} p="xs">
        <Group justify="center" gap="xs" mih={36}>
          <IconPaperclip size={16} />
          <Text size="sm" c="dimmed">
            Drop files or click to attach (5 MB total max)
          </Text>
        </Group>
      </Dropzone>
      {files.length > 0 && (
        <Group gap={6}>
          {files.map((f, i) => (
            <Badge
              key={i}
              variant="light"
              rightSection={<CloseButton size="xs" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label="Remove" />}
            >
              {f.name} · {fmtSize(f.size)}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}

// Builds the request body for reply/compose; throws a user-facing message on problems.
export async function buildOutgoing(editor: Editor | null, files: File[]) {
  if (!editor || editor.isEmpty) throw new Error("Message body is empty");
  const html = editor.getHTML();
  const text = editor.getText({ blockSeparator: "\n\n" });
  const total = html.length + text.length + files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_SEND_BYTES) throw new Error("Message exceeds 5 MB");
  const attachments: OutAttachment[] = await Promise.all(
    files.map(async (f) => ({ filename: f.name, type: f.type || "application/octet-stream", content: await fileToBase64(f) })),
  );
  return { html, text, attachments };
}
