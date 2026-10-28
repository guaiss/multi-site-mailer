import { ActionIcon, Code, CopyButton, Group, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react";
import { useState } from "react";

// Masked key with show/hide and copy. Falls back to the prefix for keys created
// before plaintext storage existed.
export default function SecretField({ value, prefix }: { value: string | null; prefix: string }) {
  const [shown, setShown] = useState(false);
  if (!value) return <Code>{prefix}…</Code>;
  return (
    <Group gap={4} wrap="nowrap">
      <Code style={{ wordBreak: "break-all" }}>{shown ? value : `${prefix}…`}</Code>
      <Tooltip label={shown ? "Hide" : "Show"}>
        <ActionIcon size="sm" variant="subtle" onClick={() => setShown((s) => !s)}>
          {shown ? <IconEyeOff size={14} /> : <IconEye size={14} />}
        </ActionIcon>
      </Tooltip>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy"}>
            <ActionIcon size="sm" variant="subtle" color={copied ? "green" : undefined} onClick={copy}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}
