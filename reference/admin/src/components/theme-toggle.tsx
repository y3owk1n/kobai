import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Theme, useTheme } from "@/lib/theme";

/**
 * Light, dark, or the machine's choice.
 *
 * Three options rather than a two-state switch, because `system` is not a third colour — it is
 * the absence of an override, and a Merchant who picked dark at midnight needs something to
 * click to hand the decision back. That makes it a set of mutually exclusive choices with one
 * selected, which is what a radio group is; the check mark falls out of the primitive rather
 * than being drawn here.
 *
 * The icon is what the Admin currently *looks like*, not what was chosen — a monitor icon
 * beside a dark screen tells a Merchant nothing about the screen.
 */
const OPTIONS = [
  { theme: "light", label: "Light", Icon: SunIcon },
  { theme: "dark", label: "Dark", Icon: MoonIcon },
  { theme: "system", label: "System", Icon: MonitorIcon },
] as const satisfies readonly { theme: Theme; label: string; Icon: typeof SunIcon }[];

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}`}>
            {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(next) => setTheme(next as Theme)}
        >
          {OPTIONS.map(({ theme: option, label, Icon }) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
