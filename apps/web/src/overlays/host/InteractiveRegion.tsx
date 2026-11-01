import type { ComponentPropsWithoutRef } from "react";
import styles from "./host.module.css";

/**
 * The host's layers let every pointer event through to the 3D city. An overlay wraps the parts
 * that should take the pointer (a panel, a button row) in this; everything else stays transparent.
 */
export function InteractiveRegion({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...rest}
      className={className ? `${styles.interactive} ${className}` : styles.interactive}
    />
  );
}
