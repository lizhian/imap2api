import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { motion, type HTMLMotionProps } from "motion/react";
import styles from "./styles.module.css";

export function IconButton({ label, children, className = "", ...props }: HTMLMotionProps<"button"> & { label: string; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={500}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <motion.button whileTap={{ scale: 0.98 }} className={`btn btn-ghost btn-square btn-sm ${styles.iconButton} ${className}`} aria-label={label} {...props}>{children}</motion.button>
        </Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content sideOffset={6} className={styles.tooltip}>{label}<Tooltip.Arrow className={styles.tooltipArrow} /></Tooltip.Content></Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function Button({ children, variant = "default", className = "", ...props }: HTMLMotionProps<"button"> & { variant?: "default" | "primary" | "danger" | "quiet" }) {
  const daisyVariant = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-error" : variant === "quiet" ? "btn-ghost" : "";
  return <motion.button whileTap={{ scale: 0.98 }} className={`btn btn-sm ${daisyVariant} ${styles.button} ${styles[variant]} ${className}`} {...props}>{children}</motion.button>;
}

export function Spinner({ label = "正在加载" }: { label?: string }) {
  return <span className="loading loading-spinner loading-sm" role="status" aria-label={label} />;
}

export function EmptyState({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return <div className={styles.emptyState}>{icon}<p>{title}</p>{action}</div>;
}
