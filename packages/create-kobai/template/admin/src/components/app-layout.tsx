import type { Session } from "@kobai/client";
import { LogOutIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { CrumbProvider } from "@/lib/crumb";
import { SECTIONS, type Section, sectionOf } from "@/lib/sections";
import { useKobai } from "@/lib/session";

/**
 * The frame every signed-in screen hangs in: a sidebar, a breadcrumb, and the Outlet.
 *
 * The Admin held its screen in `useState` and its navigation in three `Button`s until #174.
 * That was honest at four screens and does not survive ten, and it made every screen
 * unlinkable — which is the whole of what a router buys here (ADR-0063).
 *
 * Everything visual comes from `components/ui/`: `Sidebar` and `Breadcrumb` are shadcn's own,
 * and this file only composes them and decides what goes in. A hand-drawn nav beside them is
 * the thing that convention rules out.
 *
 * **What the sections are is `lib/sections.ts`'s**, and was a `const` here until #177 put a
 * command palette beside the sidebar. Two affordances over one list is the whole reason it
 * moved: a copy in each is how they come to disagree about what this Admin has.
 */
export function AppLayout({ session }: { readonly session: Session }) {
  const { signOut } = useKobai();
  const here = sectionOf(useLocation().pathname);
  // What the screen under the Outlet calls the record it is showing, if it has one yet. The
  // layout owns the state and the screen writes to it through `CrumbProvider`, because the
  // title is a thing only the screen's own request knows — see `lib/crumb.tsx`.
  const [record, setRecord] = useState<string | null>(null);

  return (
    <SidebarProvider>
      {/* A landmark, and `complementary` rather than `navigation` because this holds the
          Merchant's account and the way out as well as the sections. Without one, every
          control in here is page content outside any landmark, which is what axe reports as
          `region` — caught by `tests/the-admin-in-a-browser.test.ts` and invisible to
          everything else in this repository. It is passed here rather than baked into
          `components/ui/sidebar.tsx`, because what a deployment's sidebar *is* belongs to the
          application composing it and not to the vendored primitive (ADR-0063). */}
      <Sidebar collapsible="icon" role="complementary" aria-label="Sections and account">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1 font-medium group-data-[collapsible=icon]:hidden">
            kobai Admin
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Store</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {SECTIONS.map((section) => (
                  <SidebarMenuItem key={section.path}>
                    <SidebarMenuButton
                      isActive={here === section}
                      tooltip={section.label}
                      render={<Link to={section.path} />}
                    >
                      <section.Icon />
                      <span>{section.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="truncate px-2 py-1 text-muted-foreground text-xs group-data-[collapsible=icon]:hidden">
                {session.merchant.email}
              </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Sign out" onClick={() => void signOut()}>
                <LogOutIcon />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <Breadcrumbs section={here} record={record} />
          <div className="ml-auto flex items-center gap-1">
            <CommandPalette />
            <ThemeToggle />
          </div>
        </header>
        {/* A `div` rather than a second `main`: `SidebarInset` is already one, and two of them
            is a document with two main landmarks — which is a real refusal from axe rather
            than a style note, and one nothing outside a browser could have seen. */}
        <div className="mx-auto w-full max-w-5xl p-6">
          {/* The section, as the document's one first-level heading — for a reader with no
              sidebar and no breadcrumb to look at. Visually hidden, because the frame already
              says it twice on screen.

              It names the **section** rather than the record, so `/products` and
              `/products/{id}` announce the same `h1`; the second one's own title is the `h2`
              under it, which is an ordinary outline rather than a missing heading. It is here
              rather than in each screen because a screen that forgot one is a page with no
              heading at all, which is what every list screen was until #175 — and #176
              rewrote all six of them, and none of them argued for a better first-level title
              than its section — a record's own title is its `h2`. */}
          <h1 className="sr-only">{here?.label ?? "Not found"}</h1>
          <CrumbProvider name={setRecord}>
            <Outlet />
          </CrumbProvider>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Where you are: the section from the URL, and the record from the screen showing it.
 *
 * The URL is all this component can derive, and for a detail screen that is an identifier — a
 * UUID in the one place a Merchant looks to find out where they are. `GET /admin/orders/{id}`
 * is what knows the number, and a layout that fetched one would be fetching it a second time
 * on every screen that already has it. So the screen says, through `lib/crumb.tsx`, and
 * **`record` is `null` until it has an answer**: the identifier stays until the title arrives,
 * rather than the crumb flickering empty and back.
 *
 * Only the **last** crumb is renamed. Everything above it is a path segment this Admin has no
 * screen for today, and inventing a name for one would be naming something nobody is looking
 * at.
 */
function Breadcrumbs({
  section,
  record,
}: {
  /** Which section this path belongs to, derived once by the layout above. */
  readonly section: Section | undefined;
  readonly record: string | null;
}) {
  const pathname = useLocation().pathname;

  if (!section) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Not found</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const rest = pathname.slice(section.path.length).split("/").filter(Boolean);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {rest.length === 0 ? (
            <BreadcrumbPage>{section.label}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink render={<Link to={section.path} />}>
              {section.label}
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {rest.map((segment, index) => (
          // Keyed by the path so far rather than by the segment: two segments of one path can
          // be equal, and two equal keys are one crumb as far as React is concerned.
          <Fragment key={rest.slice(0, index + 1).join("/")}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {index === rest.length - 1 ? (
                <BreadcrumbPage className="max-w-64 truncate">
                  {record ?? segment}
                </BreadcrumbPage>
              ) : (
                <span className="max-w-64 truncate">{segment}</span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
