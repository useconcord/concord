import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Password } from "./Auth";

describe("password visibility control", () => {
  it("uses a changing action label without contradictory pressed semantics", async () => {
    render(<Password label="Password" value="secret" onChange={vi.fn()} />);
    const show = screen.getByRole("button", { name: "Show" });
    expect(show).not.toHaveAttribute("aria-pressed");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await userEvent.click(show);
    const hide = screen.getByRole("button", { name: "Hide" });
    expect(hide).not.toHaveAttribute("aria-pressed");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
  });
});
