import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount rendered components between tests so queries don't see stale DOM.
afterEach(() => {
  cleanup();
});
