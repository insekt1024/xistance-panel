"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle } from "lucide-react";

export interface FormFieldProps {
  label: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

function FormField({ label, error, required, htmlFor, className, children }: FormFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className={cn(error && "text-destructive")}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <XCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export interface FormInputProps extends Omit<React.ComponentProps<"input">, "children"> {
  label: string;
  error?: string;
  required?: boolean;
  valid?: boolean;
  showStatus?: boolean;
}

const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(
  ({ label, error, required, valid, showStatus = true, className, id, ...props }, ref) => {
    const fallbackId = React.useId();
    const inputId = id || fallbackId;
    return (
      <FormField label={label} error={error} required={required} htmlFor={inputId}>
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            className={cn(
              "flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-all duration-200 placeholder:text-muted-foreground hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
              error
                ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30"
                : "border-input",
              showStatus && valid && !error && "border-success/60",
              className,
            )}
            {...props}
          />
          {showStatus && valid && !error && (
            <CheckCircle2 className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-success" />
          )}
        </div>
      </FormField>
    );
  },
);
FormInput.displayName = "FormInput";

export interface FormSelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  required?: boolean;
  valid?: boolean;
  showStatus?: boolean;
  placeholder?: string;
  children: React.ReactNode;
  className?: string;
}

function FormSelect({
  label,
  value,
  onValueChange,
  error,
  required,
  valid,
  showStatus = true,
  placeholder,
  children,
  className,
}: FormSelectProps) {
  const selectId = React.useId();
  return (
    <FormField label={label} error={error} required={required} htmlFor={selectId}>
      <div className="relative">
        <select
          id={selectId}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            "flex h-9 w-full appearance-none items-center justify-between whitespace-nowrap rounded-md border bg-transparent px-3 py-1 pr-8 text-sm shadow-sm transition-all duration-200 placeholder:text-muted-foreground hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
            error
              ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30"
              : "border-input",
            showStatus && valid && !error && "border-success/60",
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
        <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {showStatus && valid && !error && (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
          <svg className="h-4 w-4 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </div>
      </div>
    </FormField>
  );
}

export interface UseFieldValidationOptions {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
  validate?: (value: string) => string | undefined;
}

export function useFieldValidation(value: string, options: UseFieldValidationOptions) {
  const [touched, setTouched] = React.useState(false);
  const error = React.useMemo(() => {
    if (!touched) return undefined;
    if (options.required && !value.trim()) return "Required";
    if (options.minLength !== undefined && value.length < options.minLength)
      return `At least ${options.minLength} characters`;
    if (options.maxLength !== undefined && value.length > options.maxLength)
      return `At most ${options.maxLength} characters`;
    if (options.pattern && !options.pattern.test(value))
      return options.patternMessage || "Invalid format";
    if (options.validate) return options.validate(value);
    return undefined;
  }, [value, touched, options]);

  const valid = touched && !error && value.trim().length > 0;

  return { error, valid, touched, setTouched };
}

export { FormField, FormInput, FormSelect };
