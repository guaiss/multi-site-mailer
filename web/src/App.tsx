import {
  ActionIcon,
  Anchor,
  AppShell,
  Burger,
  Center,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconHistory,
  IconInbox,
  IconKey,
  IconLock,
  IconListDetails,
  IconMoon,
  IconSun,
  IconTemplate,
  IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { api, ApiError } from "./api";
import MailboxNav from "./components/MailboxNav";
import AuditPage from "./pages/AuditPage";
import DomainsPage from "./pages/DomainsPage";
import InboxPage from "./pages/InboxPage";
import LogsPage from "./pages/LogsPage";
import SitesPage from "./pages/SitesPage";
import TokensPage from "./pages/TokensPage";
import TemplatesPage from "./pages/TemplatesPage";
import ThreadPage from "./pages/ThreadPage";

const NAV = [
  { to: "/sites", label: "Sites & keys", icon: IconKey },
  { to: "/tokens", label: "API tokens", icon: IconLock },
  { to: "/templates", label: "Templates", icon: IconTemplate },
  { to: "/domains", label: "Domains", icon: IconWorld },
  { to: "/logs", label: "Send log", icon: IconListDetails },
  { to: "/audit", label: "Audit log", icon: IconHistory },
];

function ColorToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  return (
    <Tooltip label="Toggle color scheme">
      <ActionIcon variant="default" onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")} aria-label="Toggle color scheme">
        {scheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

export default function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ email: string }>("/me"), retry: false });

  if (me.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (me.error) {
    const denied = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
    return (
      <Center h="100vh">
        <Stack align="center">
          <Title order={3}>{denied ? "Not signed in or not authorized" : "Failed to load"}</Title>
          <Text c="dimmed">{denied ? "Sign in through Cloudflare Access with an account on the admin list." : me.error.message}</Text>
          <Anchor onClick={() => window.location.reload()}>Reload</Anchor>
        </Stack>
      </Center>
    );
  }

  const go = (to: string) => {
    navigate(to);
    close();
  };

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 280, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Title order={4}>Mailer</Title>
          </Group>
          <Group gap="sm">
            <Text size="sm" c="dimmed" visibleFrom="xs">
              {me.data.email}
            </Text>
            <ColorToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <NavLink
            label="Inbox"
            leftSection={<IconInbox size={18} />}
            active={pathname === "/inbox" && !new URLSearchParams(location.search).get("mailbox") && !new URLSearchParams(location.search).get("domain")}
            onClick={() => go("/inbox")}
          />
          <MailboxNav onNavigate={close} />
        </AppShell.Section>
        <AppShell.Section>
          {NAV.map((n) => (
            <NavLink key={n.to} label={n.label} leftSection={<n.icon size={18} />} active={pathname.startsWith(n.to)} onClick={() => go(n.to)} />
          ))}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/t/:threadId" element={<ThreadPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/domains" element={<DomainsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
