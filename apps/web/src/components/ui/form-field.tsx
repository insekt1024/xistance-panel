"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
  RADIX_SELECT_CHILD,
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, XCircle } from "lucide-react";

export interface FormFieldProps {
  label: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  /**
   * Extra text announced with the control, e.g. a hint. Rendered visibly under
   * the label and referenced by aria-describedby alongside the error.
   */
  hint?: string;
  className?: string;
  children: React.ReactNode | ((ids: FieldIds) => React.ReactNode);
}

/**
 * The error and hint are *programmatically associated* with the control rather
 * than merely rendered beside it (WCAG 1.3.1, 3.3.1). `FormField` cannot set
 * attributes on its `children`, so it publishes the ids through context and
 * `FormInput`/`FormSelect` read them and apply them to the real element. A
 * wrapper that only rendered the text would leave a screen-reader user with an
 * input that silently fails validation and no announcement of why.
 */
export interface FieldIds {
  errorId: string;
  hintId: string;
  hasError: boolean;
  hasHint: boolean;
}

const FieldIdsContext = React.createContext<FieldIds | null>(null);

/**
 * Ids plus the attributes a control must apply. Exported for custom controls.
 *
 * The context is read by the CONTROL, which renders as a child of
 * `<FormField>`. A component cannot read context from its own parent subtree
 * during its own render, so the previous version always saw `null`, returned
 * `{}`, and every input shipped with no `id`, no `aria-invalid` and no
 * `aria-describedby` -- silently failing WCAG 1.3.1 / 3.3.1 on every form in
 * the app. FormField now passes the ids down as a render prop instead.
 */
export function fieldAttrs(ids: FieldIds, controlId: string) {
  const describedBy = [ids.hasHint ? ids.hintId : null, ids.hasError ? ids.errorId : null]
    .filter(Boolean)
    .join(" ");
  return {
    id: controlId,
    "aria-invalid": ids.hasError || undefined,
    "aria-describedby": describedBy || undefined,
  };
}

export function useFieldIds(controlId: string, ctx?: FieldIds | null) {
  const fromParent = React.useContext(FieldIdsContext);
  const source = ctx ?? fromParent;
  return React.useMemo(() => {
    if (!source) return {};
    const describedBy = [source.hasHint ? source.hintId : null, source.hasError ? source.errorId : null]
      .filter(Boolean)
      .join(" ");
    return {
      id: controlId,
      "aria-invalid": source.hasError || undefined,
      "aria-describedby": describedBy || undefined,
    };
  }, [source, controlId]);
}

/**
 * Renders the label/hint/error shell and hands the generated ids to the control.
 *
 * `children` may be a plain node (for callers that manage their own ids) or a
 * function receiving the ids, which is the only way the control can attach
 * `aria-invalid`/`aria-describedby` to the element it actually renders. Passing
 * them through React context alone does not work: the control renders as a
 * child, so it cannot read context during its own render.
 */
function FormField({ label, error, required, hint, htmlFor, className, children }: FormFieldProps) {
  const uid = React.useId();
  const errorId = `${uid}-error`;
  const hintId = `${uid}-hint`;
  const value = React.useMemo(
    () => ({ errorId, hintId, hasError: Boolean(error), hasHint: Boolean(hint) }),
    [errorId, hintId, error, hint],
  );
  return (
    <FieldIdsContext.Provider value={value}>
      <div className={cn("space-y-1.5", className)}>
        <Label htmlFor={htmlFor} className={cn(error && "text-destructive")}>
          {label}
          {/* The asterisk is decorative: `required` on the control is what is
              exposed to assistive technology, so announcing "*" too would be
              redundant noise. */}
          {required && (
            <span aria-hidden="true" className="ms-0.5 text-destructive">
              *
            </span>
          )}
        </Label>
        {hint && (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {typeof children === "function" ? children(value) : children}
        {/*
          role="alert" so the message is announced when it appears. Without it
          the text simply exists on the page and a non-sighted user never learns
          the field failed (WCAG 3.3.1).
        */}
        {error && (
          <p id={errorId} role="alert" className="flex items-center gap-1 text-xs text-destructive">
            <XCircle aria-hidden="true" className="h-3 w-3 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </FieldIdsContext.Provider>
  );
}

export interface FormInputProps extends Omit<React.ComponentProps<"input">, "children"> {
  label: string;
  error?: string;
  required?: boolean;
  valid?: boolean;
  showStatus?: boolean;
  /** Text announced when `valid` — the check icon alone is colour-only (1.4.1). */
  validLabel?: string;
  hint?: string;
}

const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(
  (
    { label, error, required, valid, showStatus = true, validLabel, hint, className, id, ...props },
    ref,
  ) => {
    const fallbackId = React.useId();
    const inputId = id || fallbackId;
    // The green border AND the check icon are both colour/shape cues. A text
    // equivalent is required; the caller supplies the localised string.
    const showValid = showStatus && valid && !error;
    return (
      <FormField label={label} error={error} required={required} hint={hint} htmlFor={inputId}>
        {(ids) => {
          const field = fieldAttrs(ids, inputId);
          const describedBy = [field["aria-describedby"], showValid ? `${inputId}-valid` : null]
            .filter(Boolean)
            .join(" ");
          return (
            <div className="relative">
              <input
                ref={ref}
                {...field}
                aria-describedby={describedBy || undefined}
                required={required}
                className={cn(
                  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                  error
                    ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30"
                    : "border-input",
                  showValid && "border-success/60",
                  className,
                )}
                {...props}
              />
              {showValid && (
                <CheckCircle2 aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 h-4 w-4 -translate-y-1/2 text-success" />
              )}
              {showValid && validLabel && (
                <span id={`${inputId}-valid`} className="sr-only">
                  {validLabel}
                </span>
              )}
            </div>
          );
        }}
      </FormField>
    );
  },
);
FormInput.displayName = "FormInput";

export interface UseFieldValidationOptions {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Message resolved by the caller, already localised. */
  patternMessage?: string;
  validate?: (value: string) => string | undefined;
  /**
   * Localised messages. Passing these in is what keeps the hook usable in a
   * Persian UI: the hook used to return literal English, which put English
   * validation text on a page whose `lang` is `fa` (WCAG 3.1.2).
   */
  messages?: {
    required: string;
    minLength: (n: number) => string;
    maxLength: (n: number) => string;
    invalidFormat: string;
  };
}

export interface FormSelectProps {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  error?: string;
  required?: boolean;
  valid?: boolean;
  showStatus?: boolean;
  validLabel?: string;
  hint?: string;
  placeholder?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A labelled select that accepts EITHER native `<option>` children or Radix
 * `<SelectItem>` children.
 *
 * The two shapes are not interchangeable. Rendering Radix children inside a
 * native <select> throws "`SelectItem` must be used within `Select`" and takes
 * down the whole route's error boundary -- /nodes was unusable in production
 * for exactly this reason. Detecting by element NAME is also unsafe: ui/select
 * sets `displayName = SelectPrimitive.Item.displayName` and minification
 * rewrites function names, so a name check always missed. The components carry
 * an explicit symbol marker instead (see ui/select.tsx).
 */
function FormSelect({
  label,
  value,
  onValueChange,
  error,
  required,
  valid,
  showStatus = true,
  validLabel,
  hint,
  placeholder,
  children,
  className,
}: FormSelectProps) {
  const selectId = React.useId();
  const showValid = showStatus && valid && !error;

  const radixChildren = React.Children.toArray(children).some(
    (c) => React.isValidElement(c) && RADIX_SELECT_CHILD in (c.type as object),
  );

  if (radixChildren) {
    return (
      <FormField label={label} error={error} required={required} hint={hint} htmlFor={selectId}>
        {(ids) => {
          const field = fieldAttrs(ids, selectId);
          const describedBy = [field["aria-describedby"], showValid ? `${selectId}-valid` : null]
            .filter(Boolean)
            .join(" ");
          return (
            <>
              <Select value={value} onValueChange={onValueChange}>
                {/* Radix's trigger is a <button>, which cannot carry `required`;
                    the required state is conveyed by FormField's label instead. */}
                <SelectTrigger id={selectId} aria-describedby={describedBy || undefined}>
                  <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>{children}</SelectContent>
              </Select>
              {showValid && validLabel && (
                <span id={`${selectId}-valid`} className="sr-only">
                  {validLabel}
                </span>
              )}
            </>
          );
        }}
      </FormField>
    );
  }

  return (
    <FormField label={label} error={error} required={required} hint={hint} htmlFor={selectId}>
      {(ids) => {
        const field = fieldAttrs(ids, selectId);
        const describedBy = [field["aria-describedby"], showValid ? `${selectId}-valid` : null]
          .filter(Boolean)
          .join(" ");
        return (
          <div className="relative">
            <select
              {...field}
              aria-describedby={describedBy || undefined}
              required={required}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              className={cn(
                "flex h-9 w-full appearance-none items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                error
                  ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30"
                  : "border-input",
                showValid && "border-success/60",
                className,
              )}
            >
              {placeholder && (
                <option value="" disabled>
                  {placeholder}
                </option>
              )}
              {children}
            </select>
            {/* The chevron is a decorative affordance: the <select> role already
                conveys that it opens a list. */}
            <svg aria-hidden="true" focusable="false" className="h-4 w-4 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
            {showValid && <CheckCircle2 aria-hidden="true" className="absolute end-2 top-1/2 h-4 w-4 -translate-y-1/2 text-success" />}
            {showValid && validLabel && (
              <span id={`${selectId}-valid`} className="sr-only">
                {validLabel}
              </span>
            )}
          </div>
        );
      }}
    </FormField>
  );
}

export function useFieldValidation(value: string, options: UseFieldValidationOptions) {
  const [touched, setTouched] = React.useState(false);
  const messages = options.messages;
  const error = React.useMemo(() => {
    if (!touched) return undefined;
    if (options.required && !value.trim()) return messages?.required;
    if (options.minLength !== undefined && value.length < options.minLength)
      return messages?.minLength(options.minLength);
    if (options.maxLength !== undefined && value.length > options.maxLength)
      return messages?.maxLength(options.maxLength);
    if (options.pattern && !options.pattern.test(value))
      return options.patternMessage ?? messages?.invalidFormat;
    if (options.validate) return options.validate(value);
    return undefined;
  }, [value, touched, options, messages]);

  const valid = touched && !error && value.trim().length > 0;

  return { error, valid, touched, setTouched };
}

export { FormField, FormInput, FormSelect };