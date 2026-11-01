import { Alert, Button, Code, Grid, Group, JsonInput, NavLink, Paper, Select, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { api, type Domain, type Template } from "../api";

interface Draft {
  domain_id: string;
  name: string;
  subject: string;
  html: string;
  text: string;
  isNew: boolean;
}

const empty: Draft = { domain_id: "*", name: "", subject: "", html: "", text: "", isNew: true };

export default function TemplatesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["templates"], queryFn: () => api<{ templates: Template[] }>("/templates") });
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const [params] = useSearchParams();
  const selectedDomain = params.get("domain");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [vars, setVars] = useState('{\n  "code": "123456",\n  "expires_minutes": 5\n}');
  const [preview, setPreview] = useState<{ subject: string; html: string | null; text: string | null } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  useEffect(() => {
    if (!draft && list.data?.templates[0]) {
      const t = list.data.templates.find((t) => !selectedDomain || t.domain_id === selectedDomain) ?? list.data.templates.find((t) => t.domain_id === "*")!;
      if (!t) return;
      setDraft({ ...t, html: t.html ?? "", text: t.text ?? "", isNew: false });
    }
  }, [list.data, draft, selectedDomain]);

  const save = useMutation({
    mutationFn: (d: Draft) => api(`/templates/${encodeURIComponent(d.domain_id)}/${d.name}`, { method: "PUT", body: { subject: d.subject, html: d.html, text: d.text } }),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Saved" });
      qc.invalidateQueries({ queryKey: ["templates"] });
      setDraft((d) => (d ? { ...d, isNew: false } : d));
    },
    onError: (e) => notifications.show({ color: "red", title: "Save failed", message: e.message }),
  });
  const del = useMutation({
    mutationFn: (d: Draft) => api(`/templates/${encodeURIComponent(d.domain_id)}/${d.name}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      setDraft(null);
    },
  });
  const runPreview = useMutation({
    mutationFn: (d: Draft) => {
      let variables: Record<string, string> = {};
      try {
        variables = JSON.parse(vars || "{}");
      } catch {
        throw new Error("Variables are not valid JSON");
      }
      return api<{ subject: string; html: string | null; text: string | null }>("/templates/preview", {
        body: { subject: d.subject, html: d.html, text: d.text, variables },
      });
    },
    onSuccess: (r) => {
      setPreview(r);
      setPreviewErr(null);
    },
    onError: (e) => {
      setPreview(null);
      setPreviewErr(e.message);
    },
  });

  const grouped = new Map<string, Template[]>();
  for (const t of (list.data?.templates ?? []).filter((t) => !selectedDomain || t.domain_id === selectedDomain || t.domain_id === "*")) grouped.set(t.domain_id, [...(grouped.get(t.domain_id) ?? []), t]);
  const domainOptions = [{ value: "*", label: "Shared (all domains)" }, ...(domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))];
  const domainLabel = (id: string) => domainOptions.find((o) => o.value === id)?.label ?? id;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Templates</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft({ ...empty, domain_id: selectedDomain ?? "*" })}>
          New template
        </Button>
      </Group>
      <Alert variant="light">
        Variables are written as <Code>{"{{name}}"}</Code> and values are HTML-escaped automatically; <Code>{"{{site_name}}"}</Code> is filled with the domain display name; <Code>{"{{domain_name}}"}</Code> contains the domain. A domain template overrides a shared template with the same name.
      </Alert>
      <Grid>
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Paper withBorder p="xs">
            {[...grouped.entries()].map(([site, ts]) => (
              <NavLink key={site} label={domainLabel(site)} defaultOpened childrenOffset={12}>
                {ts.map((t) => (
                  <NavLink
                    key={t.name}
                    label={t.name}
                    active={draft?.domain_id === t.domain_id && draft?.name === t.name && !draft.isNew}
                    onClick={() => {
                      setDraft({ ...t, html: t.html ?? "", text: t.text ?? "", isNew: false });
                      setPreview(null);
                    }}
                  />
                ))}
              </NavLink>
            ))}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          {draft && (
            <Stack>
              <Group grow>
                <Select label="Domain" data={domainOptions} value={draft.domain_id} onChange={(v) => set({ domain_id: v ?? "*" })} disabled={!draft.isNew} />
                <TextInput label="Template name" description="[a-z0-9_]" value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} disabled={!draft.isNew} />
              </Group>
              <TextInput label="Subject" value={draft.subject} onChange={(e) => set({ subject: e.currentTarget.value })} />
              <Textarea label="HTML body" autosize minRows={6} maxRows={20} ff="monospace" value={draft.html} onChange={(e) => set({ html: e.currentTarget.value })} />
              <Textarea label="Plain-text body" autosize minRows={4} maxRows={12} value={draft.text} onChange={(e) => set({ text: e.currentTarget.value })} />
              <JsonInput label="Preview variables" autosize minRows={3} value={vars} onChange={setVars} formatOnBlur />
              <Group>
                <Button loading={save.isPending} onClick={() => save.mutate(draft)}>
                  Save
                </Button>
                <Button variant="default" loading={runPreview.isPending} onClick={() => runPreview.mutate(draft)}>
                  Preview
                </Button>
                {!draft.isNew && (
                  <Button
                    color="red"
                    variant="subtle"
                    onClick={() =>
                      modals.openConfirmModal({
                        title: "Delete template",
                        children: <Text size="sm">Websites that send with this template will start failing.</Text>,
                        confirmProps: { color: "red" },
                        onConfirm: () => del.mutate(draft),
                      })
                    }
                  >
                    Delete
                  </Button>
                )}
              </Group>
              {previewErr && <Text c="red">{previewErr}</Text>}
              {preview && (
                <Paper withBorder p="sm">
                  <Text fw={600} mb="xs">
                    {preview.subject}
                  </Text>
                  {preview.html && (
                    <iframe title="preview" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 320, border: 0, background: "white" }} />
                  )}
                  {preview.text && (
                    <Code block mt="xs">
                      {preview.text}
                    </Code>
                  )}
                </Paper>
              )}
            </Stack>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
