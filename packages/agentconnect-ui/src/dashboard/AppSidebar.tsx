import type { ElementType } from 'react';

import { House, PiggyBank, Settings, TrendingUp } from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@polygonlabs/design-system';

export type Page = 'overview' | 'markets' | 'yield' | 'settings';

interface NavItem {
  id: Page;
  label: string;
  icon: ElementType;
}

const GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [{ id: 'overview', label: 'Overview', icon: House }] },
  {
    label: 'Earn',
    items: [
      { id: 'markets', label: 'Markets', icon: TrendingUp },
      { id: 'yield', label: 'Yield', icon: PiggyBank }
    ]
  },
  { label: 'Admin', items: [{ id: 'settings', label: 'Settings', icon: Settings }] }
];

interface AppSidebarProps {
  page: Page;
  onNavigate: (page: Page) => void;
}

// Below md the design system renders this as a drawer, which owns Esc, backdrop and focus.
export function AppSidebar({ page, onNavigate }: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();
  const select = (id: Page) => {
    onNavigate(id);
    setOpenMobile(false);
  };

  return (
    // z-0 so dialog scrims (unindexed, later in the DOM) paint above the fixed sidebar.
    <Sidebar className="top-16 z-0 h-[calc(100svh-4rem)]">
      <SidebarContent className="gap-6 px-0 py-4">
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label ?? 'main'} className="px-4 py-0 md:px-4">
            {group.label && (
              <SidebarGroupLabel className="px-4 text-muted">{group.label}</SidebarGroupLabel>
            )}
            <SidebarMenu>
              {group.items.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={page === id}
                    aria-current={page === id ? 'page' : undefined}
                    onClick={() => select(id)}
                    className="px-4 font-medium text-primary hover:bg-background-muted data-active:bg-transparent"
                  >
                    <Icon className="stroke-[1.5]" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="px-8 py-8 md:px-8">
        <img
          src="/open-money-stack-logo.svg"
          alt="Polygon, open money stack"
          width={124}
          height={40}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
