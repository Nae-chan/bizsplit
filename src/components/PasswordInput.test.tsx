// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordInput } from "./PasswordInput";

function Harness() {
  const [value, setValue] = useState("");
  return <PasswordInput value={value} onChange={setValue} />;
}

describe("PasswordInput", () => {
  it("hides input by default and reveals on toggle", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText("Password");
    await user.type(input, "hunter2secret");
    expect(input).toHaveProperty("type", "password");

    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(input).toHaveProperty("type", "text");
    expect(input).toHaveProperty("value", "hunter2secret");

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input).toHaveProperty("type", "password");
  });

  it("does not submit the surrounding form when toggled", async () => {
    const user = userEvent.setup();
    let submitted = false;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted = true;
        }}
      >
        <Harness />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(submitted).toBe(false);
  });
});
