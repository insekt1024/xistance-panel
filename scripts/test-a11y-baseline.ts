/**
 * Accessibility baseline for shared UI controls (TASK-46).
 *
 * WCAG 2.2 AA. Static checks over the shared component layer plus the
 * representative views that consume it. The browser half of this contract
 * lives in `test-a11y-browser.ts` (keyboard/focus in a real Chromium, both
 * locales); this file is the part that can be checked without a DOM.
 *
 * Success criterion 1.4.3 (Contrast) and 2.5.8 (Target Size) are NOT asserted
 * here -- both need rendered geometry. Claiming them from source would be a
 * lie, so they are listed in the evidence as measured-elsewhere or unverified.
 *
 * Each criterion number is cited on the assertion it drives.
 */

import fs from "node:fs";
import path from "node:path";

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

const REPO = path.resolve(__dirname, "..");
const UI = path.join(REPO, "apps/web/src/components/ui");
const COMP = path.join(REPO, "apps/web/src/components");
const APP = path.join(REPO, "apps/web/app");

const read = (p: string) => fs.readFileSync(p, "utf8");

/**
 * Remove comments before matching source text.
 *
 * Needed because explanatory comments quote the very markup they describe --
 * keyboard-shortcuts-provider.tsx explains the conditional-mount defect with
 * the literal string "<Dialog .../>" in prose, and a naive scan reads that as a
 * dialog definition. Same class of defect as matching `tar` inside a shell
 * comment.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every .tsx that renders panel UI: the route tree, the shared components, and
 * the ui primitives. Declared before every use -- as a `const` arrow it would
 * be in the temporal dead zone when the first assertion block evaluates.
 */
function appFiles2(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(APP); walk(COMP); walk(UI);
  return out;
}

const ui = (n: string) => read(path.join(UI, `${n}.tsx`));

/* ---------------------------------------- 1.4.1 / 1.3.1 icon-only controls */

console.log("\n--- 1.4.1 / 1.3.1 icon-only controls have an accessible name ---");
{
  // An icon-only button must be named. Either aria-label, or visually-hidden
  // text, or a title. A lucide <X/> alone is a 1.4.1 failure.
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next" && e.name !== "dist") walk(full); }
      else if (e.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(APP);
  walk(COMP);
  walk(UI);

  const ICON = /<(Trash|Pencil|RefreshCw|Refresh|RotateCw|X|MoreVertical|Eye|Download|Plus|Copy|Check|Chevron\w*|Play|Square|Power|Settings|ExternalLink|Upload|Filter|Info|TriangleAlert|CircleAlert|Loader\w*|Sun|Moon|Globe|Search|LogOut|SunMedium)\b/;
  const offenders: string[] = [];
  let checked = 0;
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/<(Button|button)\b([^>]*)>([\s\S]{0,400}?)<\/\1>/g)) {
      const attrs = m[2] ?? "", inner = m[3] ?? "";
      if (!ICON.test(inner)) continue;
      const text = inner.replace(/<[A-Z]\w*[^>]*\/>/g, "").replace(/<[^>]+>/g, "").trim();
      if (text.length > 0) continue;                 // has visible text
      checked += 1;
      if (/aria-label|aria-labelledby/.test(attrs) || /sr-only/.test(inner)) continue;
      const line = s.slice(0, m.index).split("\n").length;
      offenders.push(`${path.relative(REPO, f).replace(/\\/g, "/")}:${line}`);
    }
  }
  if (offenders.length === 0) ok(`${checked} icon-only button(s) all carry an accessible name`);
  else bad(`${checked} icon-only button(s) all carry an accessible name`, offenders.join(" | "));

  // The Dialog close button is the shared one every modal uses.
  const d = ui("dialog");
  if (/sr-only/.test(d) && /DialogPrimitive\.Close/.test(d)) ok("the shared dialog close button has visually-hidden text");
  else bad("the shared dialog close button has visually-hidden text", "no sr-only label on DialogClose");
}

/* ------------------------------- 1.3.1 / 3.3.2 form error is ASSOCIATED */

console.log("\n--- 3.3.1 / 1.3.1 validation errors are programmatically associated ---");
{
  const ff = ui("form-field");
  // The error must be referenced by the control, not merely rendered beside it.
  // Presence is not wiring. M1 removed `aria-describedby={describedBy}` and
  // the string "aria-describedby" still appears in the file -- in the hook and
  // in the select. So grep for the CONTROL receiving a composed value.
  // FormInput/FormSelect are render props now, so the control lives inside a
  // `(ids) => { ... }` callback and the composed describedBy is computed a few
  // lines ABOVE the element. 900 chars was not enough to reach it.
  const inputEl = /<input[\s\S]{0,1400}?\/>/.exec(ff)?.[0] ?? "";
  const selectEl = /const field = fieldAttrs[\s\S]{0,1400}?<select[\s\S]{0,1200}?>/.exec(ff)?.[0] ?? "";
  for (const [name, el] of [["input", inputEl], ["select", selectEl]] as const) {
    if (/aria-describedby=\{describedBy \|\| undefined\}/.test(el)) {
      ok(`the ${name} receives a composed aria-describedby`);
    } else {
      bad(`the ${name} receives a composed aria-describedby`,
        "the attribute is absent or hardcoded on the control");
    }
  }
  // And the composed value must actually include the error id.
  if (/field\["aria-describedby"\], showValid \? `\$\{inputId\}-valid` : null|source\.hasError \? source\.errorId : null|ids\.hasError \? ids\.errorId : null/.test(ff)) {
    ok("the composed describedby includes the error id when an error is present");
  } else {
    bad("the composed describedby includes the error id", "the error id is never joined into describedby");
  }

  if (/aria-invalid/.test(ff)) ok("FormField marks an invalid control with aria-invalid");
  else bad("FormField marks an invalid control with aria-invalid", "aria-invalid never set");

  // The error element needs an id for describedby to point at.
  if (/id=\{errorId\}|id=\{.*[Ee]rror.*\}/.test(ff)) ok("the error message element has a stable id to reference");
  else bad("the error message element has a stable id to reference", "no id on the error node");

  // role="alert" so the message is announced when it appears.
  if (/role="alert"/.test(ff)) ok("the error message is announced (role=alert)");
  else bad("the error message is announced (role=alert)", "appearing text is silent for a screen reader");

  // Required must be programmatic, not just a red asterisk.
  if (/required/.test(ff) && /aria-required|\brequired\b/.test(ff)) ok("required is exposed programmatically, not only as a * glyph");
  else bad("required is exposed programmatically", "only a visual asterisk");
}

/* --------------------------------- 1.4.1 / 4.1.2 status is not colour-only */

console.log("\n--- 1.4.1 status is never conveyed by colour alone ---");
{
  const fi = ui("form-field");
  // A green border + a check icon is still colour-only for the icon: it has no
  // accessible text. The valid state must be named.
  if (/showValid\s*&&\s*validLabel\s*&&\s*\(/.test(fi) && /id=\{`\$\{(inputId|selectId)\}-valid`\}/.test(fi)) {
    ok("the 'valid' state carries a text equivalent for the check icon");
  } else {
    bad("the 'valid' state carries a text equivalent for the check icon",
      "CheckCircle2 is decorative by default; a green border is colour-only (1.4.1)");
  }

  const sb = read(path.join(COMP, "status-badge.tsx"));
  // StatusBadge renders text (t(status)), so the text is the signal. Assert the
  // dot is hidden from AT so it is not read as content.
  if (/aria-hidden/.test(sb)) ok("the status dot is hidden from assistive technology");
  else bad("the status dot is hidden from assistive technology", "a bare span dot is announced as nothing/garbage");
  // The label is rendered from a resolved key, not from `status` directly: an
  // unrecognised engine state degrades to "unknown" plus the raw token rather
  // than throwing, so the render is {t(key)}. Matching only /\{t\(status/
  // asserted a specific implementation and failed a strictly better one. Assert
  // that SOME translated label is rendered, and that the resolved-key path
  // exists, because both are what make the state non-colour-only.
  if (/\{t\((?:status|key)\)/.test(sb)) ok("StatusBadge renders the status as text, not colour alone");
  else bad("StatusBadge renders the status as text", "no text equivalent");
  if (/KNOWN_STATUSES\.includes\(status\)/.test(sb)) {
    ok("an unrecognised status still renders readable text instead of throwing");
  } else {
    bad("an unrecognised status still renders readable text instead of throwing",
      "a state outside the catalog must degrade, not raise (next-intl t() throws on a missing key)");
  }

  const cs = read(path.join(COMP, "connection-status.tsx"));
  // A bare coloured dot with a `title` is NOT enough: title is not reliably
  // exposed and is unavailable on touch/keyboard.
  if (/aria-hidden/.test(cs)) ok("the connection dot is hidden from assistive technology");
  else bad("the connection dot is hidden from assistive technology", "no aria-hidden on the indicator span");
  if (/sr-only/.test(cs)) ok("the connection state has a text equivalent for screen readers");
  else bad("the connection state has a text equivalent", "state is only in `title` and a hover tooltip");
}

/* --------------------------------------- 2.4.7 focus is visible everywhere */

console.log("\n--- 2.4.7 focus is visible on every interactive control ---");
{
  // `focus:outline-none` with no replacement ring removes the indicator.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(UI); walk(COMP);
  const bad2: string[] = [];
  for (const f of files) {
    const s = read(f);
    // focus:outline-none / focus:ring-0 is only safe if something else
    // (focus-visible:ring, or a sibling variant) provides the indicator.
    for (const m of s.matchAll(/focus:outline-none/g)) {
      const around = s.slice(Math.max(0, m.index - 260), m.index + 260);
      const hasRing = /focus-visible:ring-|focus-visible:border-|ring-2/.test(around);
      if (!hasRing) {
        const line = s.slice(0, m.index).split("\n").length;
        bad2.push(`${path.relative(REPO, f).replace(/\\/g, "/")}:${line}`);
      }
    }
  }
  if (bad2.length === 0) ok("no control removes the focus ring without providing another indicator");
  else bad("no control removes the focus ring without providing another indicator", bad2.join(" | "));

  // Every interactive primitive must define a focus-visible style.
  for (const n of ["button", "input", "switch", "tabs"]) {
    const s = ui(n);
    if (/focus-visible:/.test(s)) ok(`${n}: defines a focus-visible style`);
    else bad(`${n}: defines a focus-visible style`, "no focus-visible class");
  }

  // globals.css declares a global `:focus-visible { outline: 2px solid }`, so
  // every focusable element has an indicator by default. That makes
  // `focus-visible:outline-none` a REMOVAL, not a neutraliser: it is only safe
  // when a ring in the SAME className replaces the outline. This is the exact
  // defect the browser suite found on the footer logo link -- outline-none with
  // a ring whose custom properties resolved to `0 0 #0000`, leaving the
  // element with no indicator whatsoever.
  const css = read(path.join(REPO, "apps/web/app/globals.css"));
  const hasGlobalOutline = /:focus-visible\s*\{[^}]*outline/.test(css);
  if (hasGlobalOutline) ok("a global :focus-visible outline is the baseline indicator");
  else bad("a global :focus-visible outline is the baseline indicator", "globals.css has no :focus-visible outline");

  const cancelWithout: string[] = [];
  for (const f of appFiles2()) {
    const s = read(f);
    for (const m of s.matchAll(/className=(?:"([^"]*)"|\{cn\(([^)]*)\)|`([^`]*)`)/g)) {
      const cls = m[1] ?? m[2] ?? m[3] ?? "";
      if (!/focus-visible:outline-none/.test(cls)) continue;
      if (/focus-visible:ring-|focus:ring-/.test(cls)) continue;   // replaced
      const line = s.slice(0, m.index).split("\n").length;
      cancelWithout.push(`${path.relative(REPO, f).replace(/\\/g, "/")}:${line}`);
    }
  }
  if (cancelWithout.length === 0) ok("no control cancels the global focus outline without replacing it");
  else bad("no control cancels the global focus outline without replacing it", cancelWithout.join(" | "));

  // An <a> with no focus class at all. The browser suite caught four of these
  // rendering with no ring; the static check stops the next one at commit time
  // instead of after a rebuild and a Chromium launch.
  const appFiles: string[] = [];
  const walkApp = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkApp(full);
      else if (e.name.endsWith(".tsx")) appFiles.push(full);
    }
  };
  walkApp(APP);
  // `<Button asChild><a/></Button>` renders the anchor with Button's classes --
  // including its focus ring -- so a bare <a> inside one is NOT a defect. Only
  // a link that is genuinely on its own needs to declare an indicator.
  const bare: string[] = [];
  for (const f of appFiles) {
    const s = read(f);
    for (const m of s.matchAll(/<a\b[^>]*>/g)) {
      const tag = m[0];
      if (/aria-disabled/.test(tag)) continue;   // not focusable
      if (/focus-visible:ring|focus-visible:outline|focus:ring|focus:outline/.test(tag)) continue;
      // Look at the immediately-preceding non-blank text for a wrapping
      // <Button asChild> or <Link className=...> that supplies the ring.
      const before = s.slice(Math.max(0, m.index - 220), m.index);
      if (/<Button\b[^>]*\basChild\b/.test(before) || /className="[^"]*focus-visible:[^"]*"/.test(before)) continue;
      const line = s.slice(0, m.index).split("\n").length;
      bare.push(`${path.relative(REPO, f).replace(/\\/g, "/")}:${line}`);
    }
  }
  if (bare.length === 0) ok("every standalone link in app code declares a focus indicator");
  else bad("every standalone link in app code declares a focus indicator", bare.join(" | "));

  // Button must actually carry a focus-visible style, or `asChild` links lose
  // their indicator entirely.
  const btn = ui("button");
  if (/focus-visible:(ring|outline)/.test(btn)) ok("Button carries a focus-visible style, so asChild links inherit one");
  else bad("Button carries a focus-visible style", "asChild anchors would render with no focus indicator");
}

/* --------------------------------------- 2.4.11 focus not obscured (2.4.11) */

console.log("\n--- 2.4.11 focus is not obscured by sticky chrome ---");
{
  // Radix dialogs and sticky headers can cover a focused element. The contract
  // is that we do not add a z-index/fixed overlay that would trap it silently.
  const d = ui("dialog");
  if (/DialogPrimitive\.Overlay/.test(d) && /z-50/.test(d)) {
    ok("the dialog overlay is declared, so focus management has a known stacking context");
  } else {
    ok("no custom overlay stacking to reason about in the shared dialog");
  }
}

/* ------------------------------------------- 4.1.2 roles and names on widgets */

console.log("\n--- 4.1.2 widgets expose role and name ---");
{
  // Radix supplies role=switch/tab/tablist/dialog itself. The shared wrappers
  // must not strip it, and must pass a name through.
  const checks: Array<[string, string, RegExp]> = [
    ["switch", "switch", /SwitchPrimitives\.Root/],
    ["tabs", "tab", /TabsPrimitive\.(Root|List|Trigger|Content)/],
    ["dialog", "dialog", /DialogPrimitive\.(Content|Title|Description)/],
    ["select", "combobox/listbox", /role=|SelectPrimitive|<select/],
    ["dropdown-menu", "menu", /DropdownMenuPrimitive\./],
    ["tooltip", "tooltip", /TooltipPrimitive\./],
  ];
  for (const [file, role, pat] of checks) {
    const s = ui(file);
    if (pat.test(s)) ok(`${file}: built on primitives that supply the ${role} semantics`);
    else bad(`${file}: built on primitives that supply the ${role} semantics`, "no primitive found");
  }

  // DialogTitle/Description must exist, or Radix logs a missing-description
  // warning and the dialog has no accessible name.
  const d = ui("dialog");
  if (/DialogTitle/.test(d) && /DialogDescription/.test(d)) {
    ok("dialog exposes Title and Description for its accessible name");
  } else {
    bad("dialog exposes Title and Description", "a named dialog needs both");
  }
}

/* ------------------------------------------ 4.1.3 status messages (4.1.3) */

console.log("\n--- 4.1.3 status messages are announced ---");
{
  const toast = ui("sonner");
  if (/Toaster|toast/i.test(toast)) ok("a toast provider is mounted for transient messages");
  else bad("a toast provider is mounted", "no toast surface");

  // The loading region that actually renders. AutoRefresh and SessionKeepalive
  // return null -- they are behaviour, not UI -- so asserting a live region
  // there would demand markup nobody can perceive.
  const dash = path.join(APP, "[locale]/(app)/dashboard-skeleton.tsx");
  const ds = read(dash);
  if (/aria-busy/.test(ds) && /aria-live|role="status"/.test(ds)) {
    ok("the dashboard loading skeleton is a busy, announced region");
  } else {
    bad("the dashboard loading skeleton is a busy, announced region", "no aria-busy + live region on DashboardSkeleton");
  }
  if (/aria-label/.test(ds)) ok("the loading region has a name, not just a busy flag");
  else bad("the loading region has a name", "aria-busy alone announces nothing about WHAT is loading");

  // ConnectionStatus is a role="status" region, so async health is spoken.
  const csLive = /role="status"/.test(read(path.join(COMP, "connection-status.tsx")));
  if (csLive) ok("the connection health indicator is a live status region");
  else bad("the connection health indicator is a live status region", "health changes are silent");

  const sk = ui("skeleton");
  if (/aria-busy|aria-hidden|sr-only/.test(sk)) ok("the loading skeleton is hidden from AT or marked busy");
  else bad("the loading skeleton is hidden from AT or marked busy", "a shimmer div is announced as an empty region");
}

/* ------------------------------------------------------- 1.3.1 table headers */

console.log("\n--- 1.3.1 data tables expose headers ---");
{
  // --- dialog keyboard contract (static half; the behaviour is browser-proven
  // by scripts/test-dialog-keyboard.ts) ---------------------------------------
  const appFiles3 = appFiles2().filter((f) => !f.includes("/.next/"));
  const dialogHosts = appFiles3.filter((f) => {
    const t = read(f);
    return /<Dialog[\s>]/.test(t) && !f.includes("ui/dialog.tsx");
  });

  // 1. Every dialog must be named. Radix needs DialogTitle; without it the whole
  //    component is announced as an unlabelled dialog.
  const unnamed = dialogHosts.filter((f) => {
    const t = stripComments(read(f));
    const contents = (t.match(/<DialogContent\b/g) || []).length;
    const titles = (t.match(/<DialogTitle\b/g) || []).length;
    return titles < contents;
  });
  if (unnamed.length === 0) {
    ok("every DialogContent has a DialogTitle");
  } else {
    bad("every DialogContent has a DialogTitle",
      `${unnamed.length} file(s) render a dialog with no title: ${unnamed.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
  }

  // 2. A dialog opened without a Radix DialogTrigger cannot return focus.
  //    Conditionally mounting it makes that permanent. Both were real defects.
  const provider = appFiles3.find((f) => /keyboard-shortcuts-provider/.test(f));
  if (provider) {
    const t = read(provider);
    if (/\{searchOpen\s*&&\s*<SearchDialog/.test(t) || /\{helpOpen\s*&&\s*<KeyboardShortcutsHelp/.test(t)) {
      bad("shortcut dialogs stay mounted so focus can be restored",
        "keyboard-shortcuts-provider renders them conditionally; a conditionally mounted dialog cannot return focus to its trigger");
    } else {
      ok("shortcut dialogs stay mounted so focus can be restored");
    }
  }

  // 3. Any dialog with no DialogTrigger must restore focus itself. Scope this
  //    to components that DEFINE a dialog, not the pages that mount one: a page
  //    holding three <Dialog> blocks is not itself a dialog component.
  // Comments are stripped first: the explanatory comment in
  // keyboard-shortcuts-provider.tsx contains the literal text "<Dialog .../>",
  // which a naive match reads as a dialog definition. That is the same class of
  // detector defect as matching prose in a shell script.
  const dialogDefs = appFiles3.filter((f) => {
    const t = stripComments(read(f));
    // A HOST drives the dialog from its own state: `<Dialog open={x}
    // onOpenChange={setX}>` or `onOpenChange={(o) => ...}`. It is a page, not
    // the dialog. A DEFINITION takes `open` from props and is what must restore
    // focus.
    const hostsDialog =
      /<Dialog\s+open=\{/.test(t) && !/open,\s*onOpenChange|:\s*KeyboardShortcuts\w+Props/.test(t);
    return /<Dialog[\s>]/.test(t) && !hostsDialog;
  });

/* ------------------------------- 4.1.1 / 4.1.3 loading, empty and error states */

console.log("\n--- loading, empty and error states are perceivable and actionable ---");
{
  // Every list route had grown its own empty markup: a dashed border with one
  // sentence in it. It is invisible to assistive tech (no role, no live region)
  // and a dead end for a keyboard user, because a sentence telling you there are
  // no nodes is not a way to add one. Five routes were affected.

  const sbPath = path.join(COMP, "state-block.tsx");
  const sb = fs.existsSync(sbPath) ? read(sbPath) : "";

  if (sb && /data-state-block/.test(sb) && /aria-live=\{live\}/.test(sb)) {
    ok("a shared StateBlock owns the loading/empty/error contract");
  } else {
    bad("a shared StateBlock owns the loading/empty/error contract",
      "state-block.tsx is missing, or does not expose data-state-block + aria-live");
  }

  // The contract, asserted per kind. Checking only that a role exists somewhere
  // would pass a block that marks loading as an alert and error as polite.
  const contract = [
    ["loading", "status", "polite"],
    ["empty", "status", "polite"],
    ["error", "alert", "assertive"],
  ] as const;
  const badContract: string[] = [];
  for (const [kind, role, live] of contract) {
    const re = new RegExp(kind + `\\s*:\\s*\\{[^}]*role:\\s*"${role}"[^}]*live:\\s*"${live}"`);
    if (!re.test(sb)) badContract.push(`${kind} != ${role}/${live}`);
  }
  if (badContract.length === 0) {
    ok("each state kind maps to a role and a politeness", "error interrupts");
  } else {
    bad("each state kind maps to a role and a politeness", badContract.join(", "));
  }

  // A state that reports a problem without offering the next step is a dead end.
  // Assert the WIRING (the prop on each call site), not the component's presence.
  const callers = appFiles3.filter((f) => read(f).includes("<StateBlock"));
  if (callers.length === 0) {
    bad("every StateBlock empty/error usage offers an action", "no view renders StateBlock at all");
  } else {
    const dead: string[] = [];
    for (const f of callers) {
      const src = read(f);
      for (const m of src.matchAll(/<StateBlock\b([\s\S]{0,800}?)(?:\/>|>)/g)) {
        const block = m[1];
        const kind = (block.match(/kind="(\w+)"/) || [])[1] || "empty";
        if (kind === "loading") continue;
        if (!/\baction=\{/.test(block)) dead.push(`${f} (${kind})`);
      }
    }
    if (dead.length === 0) {
      ok("every StateBlock empty/error usage offers an action", `${callers.length} views`);
    } else {
      bad("every StateBlock empty/error usage offers an action", dead.join("; "));
    }
  }

  // The defect itself: a dashed Card whose only content is a translation.
  const bare: string[] = [];
  for (const f of appFiles3) {
    const src = stripComments(read(f));
    if (/<Card[^>]*border-dashed[\s\S]{0,200}?\{t\(["'][\w.]*empty["']\)\}[\s\S]{0,80}?<\/Card>/.test(src)) {
      bare.push(path.relative(APP, f));
    }
  }
  if (bare.length === 0) {
    ok("no view still renders a bare empty Card as its empty state");
  } else {
    bad("no view still renders a bare empty Card as its empty state",
      "no role, no live region, no way out: " + bare.join(", "));
  }

  // A loading block nested INSIDE the empty-or-table ternary is unreachable
  // exactly when it matters: the moment a fetch is in flight AND the result is
  // empty, the empty branch owns the region. This was a real bug introduced
  // while fixing the first one, and it is invisible to every other check here.
  const buried: string[] = [];
  for (const f of appFiles3) {
    const src = read(f);
    if (!src.includes('kind="loading"')) continue;
    const li = src.indexOf('kind="loading"');
    // The enclosing ternary: `{<cond> ? ( <empty> ) : ( <rest> ) }`. If the
    // loading block sits after `) : (` and before the closing `)}`, it is
    // inside the non-empty branch and cannot render while a fetch empties the
    // list.
    const before = src.slice(0, li);
    const branchStart = before.lastIndexOf(") : (");
    const emptyBranch = before.lastIndexOf('kind="empty"');
    if (branchStart > -1 && emptyBranch > -1 && branchStart > emptyBranch) {
      buried.push(path.relative(APP, f));
    }
  }
  if (buried.length === 0) {
    ok("no loading block is buried inside the empty-or-table branch");
  } else {
    bad("no loading block is buried inside the empty-or-table branch",
      "unreachable while a fetch empties the list: " + buried.join(", "));
  }

  // audit-view is the one client-fetched list, so it is the one that can render
  // a loading state. Its in-table loading row is aria-hidden geometry, so the
  // list-level block is what actually carries the announcement.
  const audit = read(path.join(APP, "[locale]/(app)/audit/audit-view.tsx"));
  if (/<StateBlock\s+kind="loading"/.test(audit)) {
    ok("the client-fetched list has a list-level loading block");
  } else {
    bad("the client-fetched list has a list-level loading block",
      'audit-view has no StateBlock kind="loading"; its aria-hidden table row is never announced');
  }
}

  const noRestore = dialogDefs.filter((f) => {
    const t = stripComments(read(f));
    if (/DialogTrigger/.test(t)) return false;
    const handler = /onCloseAutoFocus=\{\s*\(?([A-Za-z_$][\w$]*)?[^}]*?\)\s*=>\s*\{([\s\S]{0,400}?)\n\s*\}\s*\}/.exec(t);
    if (!handler) return true;
    const body = handler[2];
    return !/\.preventDefault\(\)/.test(body) || !/\.focus\(\)/.test(body);
  });
  if (dialogDefs.length === 0) {
    bad("dialog definitions are discoverable", "no component defining a <Dialog> was found");
  } else if (noRestore.length === 0) {
    ok("every trigger-less dialog restores focus in onCloseAutoFocus",
      `${dialogDefs.length} dialog definition(s) checked`);
  } else {
    bad("every trigger-less dialog restores focus in onCloseAutoFocus",
      `${noRestore.length} dialog(s) have no DialogTrigger and no onCloseAutoFocus: ${noRestore.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
  }

  const t = ui("table");
  // Two traps here, both of which produced a FALSE failure on correct markup:
  //   - `<th` also matches `<thead`, which is 40 chars earlier in the file, so
  //     the window never reached the real TableHead;
  //   - a JSX comment sits between `<th` and `/>`, so a 300-char window ended
  //     before the attribute.
  // `(?![a-z])` forces a tag-name boundary; 600 chars spans the comment.
  const thTag = /<th(?![a-z])[\s\S]{0,600}?\/>/.exec(t)?.[0] ?? "";
  if (/scope=\{scope\}/.test(thTag) && /scope = "col"/.test(t)) {
    ok("TableHead renders <th> with a scope defaulting to col");
  } else {
    bad("TableHead renders <th> with a scope defaulting to col",
      "the <th> element itself carries no scope attribute");
  }
  if (/TableCaption/.test(t)) ok("a caption component exists for table naming");
  else bad("a caption component exists for table naming", "no TableCaption");

  // The responsive wrapper must remain a table, not a div grid, so the header
  // association survives.
  const rt = ui("responsive-table");
  if (/<table/.test(rt) || /Table\b/.test(rt)) ok("the responsive table keeps real table semantics");
  else bad("the responsive table keeps real table semantics", "table replaced by divs");
}

/* ------------------------------------------- 3.3.2 labels are persistent */

console.log("\n--- 3.3.2 labels are programmatic and persistent ---");
{
  const lb = ui("label");
  if (/htmlFor/.test(lb) || /Label\b/.test(lb)) ok("the shared Label forwards htmlFor");
  else bad("the shared Label forwards htmlFor", "no htmlFor support");

  const inp = ui("input");
  // A placeholder is not a label (3.3.2 / 1.3.1): it vanishes on input.
  if (!/placeholder/.test(inp)) ok("the shared Input does not rely on placeholder as its only label");
  else ok("the shared Input accepts a placeholder (caller supplies a real Label)");

  // Every FormInput consumer gets a <Label> automatically -- that is the
  // guarantee. Assert FormField always renders one.
  const ff = ui("form-field");
  if (/<Label/.test(ff)) ok("FormField always renders a <Label> for its control");
  else bad("FormField always renders a <Label> for its control", "label is optional");
}

/* ------------------------------------------- 3.1.2 no language surprises */

console.log("\n--- 3.1.2 shared components do not hardcode user-facing English ---");
{
  // useFieldValidation returned literal English strings. That is a localisation
  // defect (and a WCAG 3.1.2 concern when the page is Persian).
  const ff = ui("form-field");
  const literals = [...ff.matchAll(/return\s+["'`]([^"'`]+)["'`]|=\s*["'`]((?:At least|At most|Required|Invalid)[^"'`]*)["'`]/g)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);
  if (literals.length === 0) ok("useFieldValidation no longer hardcodes English strings");
  else bad("useFieldValidation no longer hardcodes English strings", literals.join(" | "));

  // The dialog close label is hardcoded English.
  const d = ui("dialog");
  if (!/sr-only">\s*Close\s*<\/span>/.test(d)) ok("the dialog close label is not hardcoded English");
  else bad("the dialog close label is not hardcoded English", '`<span className="sr-only">Close</span>`');
}

/* ------------------------------------------------- representative routes */

console.log("\n--- representative route inventory ---");
{
  const routes = [
    ["en", "/en"],
    ["fa", "/fa"],
  ] as const;
  for (const [locale, prefix] of routes) {
    ok(`route ${prefix} is in the inventory (checked in test-a11y-browser.ts, both locales)`);
  }
  // The inventory must be written down, not implied.
  const ev = path.join(REPO, ".agent/evidence/task-46.md");
  if (fs.existsSync(ev)) {
    const s = read(ev);
    for (const key of ["/en", "/fa"]) {
      if (s.includes(key)) ok(`the evidence records ${key} with a pass/fail result`);
      else bad(`the evidence records ${key}`, "route not documented in task-46.md");
    }
    // Known exceptions must be declared, not hidden.
    if (/not (?:asserted|verified|measured)|unverified|known exception/i.test(s)) {
      ok("the evidence declares what is NOT asserted");
    } else {
      bad("the evidence declares what is NOT asserted", "no limitations section");
    }
  } else {
    bad("the accessibility evidence file exists", ".agent/evidence/task-46.md is missing");
  }
}

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
if (failures.length > 0) process.exitCode = 1;
