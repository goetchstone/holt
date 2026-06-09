// /app/src/components/ui/button.tsx

import { ButtonHTMLAttributes, forwardRef } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline";
  size?: "default" | "sm";
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", fullWidth = false, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          // Use the condensed font for a sharper, more premium feel
          "font-serif-condensed font-semibold tracking-wide", // Added tracking for better letter spacing
          "transition shadow-md",
          "inline-flex items-center justify-center rounded-lg",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          {
            // Size variants
            "px-4 py-2 text-sm": size === "default",
            "px-3 py-1.5 text-sm": size === "sm",

            // Style variants
            "bg-sh-blue text-white hover:bg-sh-black": variant === "primary",
            "bg-white text-sh-blue border border-sh-blue hover:bg-sh-gray": variant === "secondary",
            "border border-sh-gray text-sh-blue bg-transparent hover:bg-sh-gray/10":
              variant === "outline",
            "w-full": fullWidth,
          },
          className,
        )}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export { Button };
