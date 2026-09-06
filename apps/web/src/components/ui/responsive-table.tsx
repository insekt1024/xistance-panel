"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface ResponsiveTableProps extends React.HTMLAttributes<HTMLDivElement> {
  headers: string[];
  children: React.ReactNode;
}

function ResponsiveTable({ headers, children, className, ...props }: ResponsiveTableProps) {
  return (
    <div className={cn("w-full", className)} {...props}>
      <div className="hidden md:block">
        <div className="relative w-full overflow-auto">{children}</div>
      </div>
      <div className="md:hidden space-y-3">
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return null;
          if (child.type === TableBodyWrapper) {
            return React.cloneElement(child as React.ReactElement<TableBodyWrapperProps>, { mobile: true, headers });
          }
          return child;
        })}
      </div>
    </div>
  );
}
ResponsiveTable.displayName = "ResponsiveTable";

interface TableBodyWrapperProps extends React.HTMLAttributes<HTMLTableSectionElement> {
  mobile?: boolean;
  headers?: string[];
}

const TableBodyWrapper = React.forwardRef<
  HTMLTableSectionElement,
  TableBodyWrapperProps
>(({ className, mobile, headers, children, ...props }, ref) => {
  if (mobile && headers) {
    return (
      <div ref={ref as React.Ref<HTMLDivElement>} className={className} {...props}>
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return null;
          return React.cloneElement(child as React.ReactElement<TableRowWrapperProps>, {
            mobile: true,
            headers,
          });
        })}
      </div>
    );
  }
  return (
    <tbody ref={ref as React.Ref<HTMLTableSectionElement>} className={className} {...props}>
      {children}
    </tbody>
  );
});
TableBodyWrapper.displayName = "TableBodyWrapper";

interface TableRowWrapperProps extends React.HTMLAttributes<HTMLTableRowElement> {
  mobile?: boolean;
  headers?: string[];
}

const TableRowWrapper = React.forwardRef<
  HTMLTableRowElement,
  TableRowWrapperProps
>(({ className, mobile, headers, children, ...props }, ref) => {
  if (mobile && headers) {
    return (
      <div
        className={cn(
          "rounded-lg border bg-card p-3 animate-fade-in-up",
          className,
        )}
        {...props}
      >
        <div className="space-y-2">
          {React.Children.toArray(children).map((cell, i) => {
            if (!React.isValidElement(cell)) return null;
            if (i === headers.length - 1) {
              return (
                <div key={i} className="pt-2 border-t">
                  {React.cloneElement(cell as React.ReactElement<React.HTMLAttributes<HTMLDivElement>>, {
                    className: cn(
                      "flex justify-end",
                      (cell.props as React.HTMLAttributes<HTMLDivElement>).className,
                    ),
                  })}
                </div>
              );
            }
            return (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground shrink-0">
                  {headers[i]}
                </span>
                <div className="text-right min-w-0">
                  {cell}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <tr ref={ref} className={className} {...props}>
      {children}
    </tr>
  );
});
TableRowWrapper.displayName = "TableRowWrapper";

export { ResponsiveTable, TableBodyWrapper, TableRowWrapper };
export type { ResponsiveTableProps, TableBodyWrapperProps, TableRowWrapperProps };
