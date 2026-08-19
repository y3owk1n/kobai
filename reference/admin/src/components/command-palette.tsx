import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SECTIONS } from "@/lib/sections";

/**
 * ⌘K, and every section of the Admin behind it.
 *
 * A sidebar stops being a pleasant way to navigate somewhere around six entries and this Admin
 * is on its way to roughly ten, so the palette is what a Merchant reaches for instead of
 * reading a list. It offers the **sections** and deliberately nothing else: a recently-viewed
 * record would have to be remembered somewhere, and remembering costs more than a section list
 * that is already written down.
 *
 * **It reads `lib/sections.ts`, which the sidebar reads too.** That is the whole reason the
 * list is a module rather than markup — two navigation affordances over one list cannot
 * disagree about what this Admin has — and it is where #178 narrows the list to the sections a
 * Role can read, once, rather than in each row offered here.
 *
 * Everything visual is `components/ui/`: `Command` is shadcn's own, `Dialog` is the one it
 * builds `CommandDialog` out of, and this file only decides what goes in (ADR-0063). It
 * composes those two rather than taking `CommandDialog` whole for one reason, marked at the
 * line: `CommandDialog` passes its props to the dialog's **root**, and the prop that says where
 * focus lands on the way out belongs to the popup. The price of that is the four positioning
 * classes below, which are `CommandDialog`'s own — so a `shadcn add command --overwrite` that
 * retunes them will not reach this file, and moving a palette a third of the way down the
 * screen is a thing to do here rather than something to go looking for upstream.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  /**
   * What the button says the shortcut is.
   *
   * Both keys always work; this only decides which one to *show*, and showing a Mac Merchant
   * `Ctrl K` would be telling them to press the awkward one. `navigator.platform` is deprecated
   * and is still the only thing every browser answers here — and being wrong about it costs a
   * label rather than a keystroke. Asked at render rather than at module load, so importing
   * this file needs no browser.
   */
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  // Where the keyboard goes when the palette closes — see `finalFocus` below.
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K on a Mac and Ctrl+K everywhere else, and both on either, because a Merchant who
      // learned one on another Admin should not have to find out which this is.
      if (event.key !== "k" && event.key !== "K") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Chrome and Firefox both bind Ctrl+K to the address bar's search, which would otherwise
      // take the keystroke and leave the palette shut.
      event.preventDefault();
      setOpen((wasOpen) => !wasOpen);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* The shortcut is the fast way in and not the only one: a palette a Merchant has to be
          told about is one most of them never open, and there is no keyboard at all on a
          phone. The `aria-label` spells the shortcut out rather than leaving the `kbd` to be
          read as a glyph — and it **contains** the visible words, because a name that dropped
          half of what is on the button is a control a Merchant can see and cannot say. */}
      <DialogTrigger
        ref={trigger}
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Search sections ${shortcut}`}
            className="text-muted-foreground"
          >
            <SearchIcon />
            Search sections
            {/* `text-foreground` rather than the button's muted colour, and no fill behind it:
                a muted glyph on `bg-muted` measured 4.2:1 and failed the audit outright, and
                the same glyph muted on the header's own background would have passed at
                4.55:1 — inside the rounding, at 11px, for the smallest text in the frame. */}
            <kbd className="pointer-events-none hidden rounded border px-1.5 font-sans text-[0.7rem] text-foreground sm:inline">
              {shortcut}
            </kbd>
          </Button>
        }
      />
      <DialogContent
        showCloseButton={false}
        className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0"
        /* **Closing puts the keyboard back on the button that opens it.** Base UI's default is
           the trigger *or the element focused before* — and the element focused before is very
           often gone, because choosing a section unmounts the screen the Merchant was on. Then
           focus falls to `<body>`, the next Tab starts at the top of the document, and a
           Merchant navigating without a mouse has silently lost their place. The header is on
           every screen, so this ref is an element that is always still there.

           Taking this line out was watched doing worse than stranding the keyboard: focus went
           back to the Open link the palette was opened from, the `keyup` of the very Enter that
           chose a section landed on it, and the Admin navigated to that Product instead. */
        finalFocus={trigger}
      >
        {/* The dialog's name and purpose, for a reader who has no palette to look at. Visually
            hidden because the input's own placeholder says the same thing on screen. */}
        <DialogHeader className="sr-only">
          <DialogTitle>Search sections</DialogTitle>
          <DialogDescription>
            Type to filter, then choose a section of the Admin to open.
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput aria-label="Search sections" placeholder="Search sections…" />
          <CommandList>
            <CommandEmpty>Nothing in this Admin is called that.</CommandEmpty>
            <CommandGroup heading="Sections">
              {SECTIONS.map((section) => (
                <CommandItem
                  key={section.path}
                  // What cmdk filters and selects on. Spelled out rather than inferred from
                  // the row's text, so an icon or a hint added beside the label later cannot
                  // change what typing matches.
                  value={section.label}
                  onSelect={() => go(section.path)}
                >
                  <section.Icon />
                  {section.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
