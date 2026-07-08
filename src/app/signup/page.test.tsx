// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SignUpPage from "./page";

vi.mock("@/lib/auth-client", () => ({
  signUp: { email: vi.fn(async () => ({ data: null, error: null })) },
}));

describe("SignUpPage validation", () => {
  it("shows an error instead of submitting when name is missing", async () => {
    const user = userEvent.setup();
    render(<SignUpPage />);
    await user.type(screen.getByLabelText("Email"), "nae@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.click(screen.getByRole("button", { name: /sign up/i }));
    expect(await screen.findByText(/name is required/i)).toBeDefined();
  });

  it("rejects a short password client-side", async () => {
    const user = userEvent.setup();
    render(<SignUpPage />);
    await user.type(screen.getByLabelText("Your name"), "Nae");
    await user.type(screen.getByLabelText("Email"), "nae@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: /sign up/i }));
    expect(await screen.findByText(/at least 10 characters/i)).toBeDefined();
  });

  it("submits valid input and shows the check-your-email screen", async () => {
    const user = userEvent.setup();
    render(<SignUpPage />);
    await user.type(screen.getByLabelText("Your name"), "Nae");
    await user.type(screen.getByLabelText("Email"), "nae@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pw");
    await user.click(screen.getByRole("button", { name: /sign up/i }));
    expect(await screen.findByText(/check your email/i)).toBeDefined();
  });
});
