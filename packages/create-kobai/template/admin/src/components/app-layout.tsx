import type { Session } from "@kobai/client";
import { KeyRoundIcon, LogOutIcon, PackageIcon, ReceiptTextIcon } from "lucide-react";
import { Fragment } from "react";
import { Link, Outlet, useLocation } from "react-router";
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
 */
type Section = {
  /** The route this is, exactly as `app.tsx` spells it. */
  readonly path: string;
  readonly label: string;
  readonly Icon: typeof PackageIcon;
};

/**
 * What a Merchant switches between. A detail screen is reached from its list and gets no entry.
 *
 * Three of them today and roughly ten by the end of the spec, which is why this is data rather
 * than markup. Nothing here is gated on a Permission yet — showing a Merchant only the sections
 * their Role can read is #178's, and it is an affordance rather than a boundary when it lands
 * (ADR-0063).
 */
const SECTIONS = [
  { path: "/products", label: "Products", Icon: PackageIcon },
  { path: "/orders", label: "Orders", Icon: ReceiptTextIcon },
  { path: "/api-keys", label: "API keys", Icon: KeyRoundIcon },
] as const satisfies readonly Section[];

/**
 * Which section a path belongs to, so a detail view keeps its list highlighted.
 *
 * **Matched at the `/` boundary and never by bare prefix.** `/products` is a bare string prefix
 * of a hypothetical `/products-archive`, which would then light up the wrong entry — the same
 * shape of mistake `/admin` being a prefix of `/admin-ui` already cost this repository once, and
 * the fix is the same one: compare against `${path}/`, so the match is a path and not a string.
 */
function sectionOf(pathname: string): Section | undefined {
  return SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
}

export function AppLayout({ session }: { readonly session: Session }) {
  const { signOut } = useKobai();
  const here = sectionOf(useLocation().pathname);

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
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
          <Breadcrumbs />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Where you are, derived from the URL and from nothing else.
 *
 * A detail screen's crumb is its identifier, because the URL is all this component has —
 * `GET /admin/products/{id}` is what knows the title, and a layout that fetched one would be
 * fetching it a second time on every screen that already has it. Naming a crumb better than
 * the id is the detail screen's own business, and #176 is where each of them arrives.
 */
function Breadcrumbs() {
  const pathname = useLocation().pathname;
  const section = sectionOf(pathname);

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
                <BreadcrumbPage className="max-w-64 truncate">{segment}</BreadcrumbPage>
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
