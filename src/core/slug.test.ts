import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { slugifyRequirement } from "./slug.js";

describe("slugifyRequirement", () => {
  it("kebab-cases a simple action-led requirement", () => {
    assert.equal(
      slugifyRequirement("Add dark mode toggle to settings page"),
      "add-dark-mode-toggle-settings-page",
    );
  });

  it("skips a biographical first sentence and uses the second", () => {
    const slug = slugifyRequirement(
      "I am a 46 year old who is out of shape. I want to establish a weight training routine that I can do at a Planet Fitness.",
    );
    // Should reflect the intent sentence, not the bio one.
    assert.match(slug, /establish/);
    assert.match(slug, /weight-training-routine/);
    assert.doesNotMatch(slug, /46/);
  });

  it('skips an "As a <role>" preamble in favor of the next sentence', () => {
    const slug = slugifyRequirement(
      "As a frontend dev on the design system team. Add a hot-reload story for the design tokens.",
    );
    assert.match(slug, /hot-reload/);
    assert.doesNotMatch(slug, /frontend/);
  });

  it("falls back to the bio sentence when there is no other sentence", () => {
    // Single-sentence bio+intent merged. Slug still meaningful, even
    // though it includes some bio words.
    const slug = slugifyRequirement(
      "As a frontend dev I want a hot-reload story for the design tokens.",
    );
    assert.match(slug, /frontend|hot-reload|design/);
  });

  it("returns empty string when input is degenerate (all stop words)", () => {
    assert.equal(slugifyRequirement("I want to do this for me"), "");
    assert.equal(slugifyRequirement(""), "");
  });

  it("truncates at a word boundary, never trailing-hyphen", () => {
    const longInput =
      "Refactor the persistence layer to introduce snapshot-based optimistic concurrency control across all session writes";
    const slug = slugifyRequirement(longInput);
    assert.ok(slug.length <= 40, `slug too long: "${slug}"`);
    assert.doesNotMatch(slug, /-$/, "slug should not end with a hyphen");
    assert.doesNotMatch(slug, /^-/, "slug should not start with a hyphen");
  });

  it("accepts an oversized first token by truncating it", () => {
    // Single 60-char token. Caller still gets something usable.
    const slug = slugifyRequirement("supercalifragilisticexpialidociousnessfactor");
    assert.equal(slug.length, 40);
    assert.equal(slug, "supercalifragilisticexpialidociousnessfa");
  });

  it("strips punctuation and emoji safely", () => {
    const slug = slugifyRequirement("Add a 🎉 confetti animation on form submit!!!");
    assert.equal(slug, "add-confetti-animation-form-submit");
  });

  it("is git-branch-safe: alphanumeric and single hyphens only", () => {
    const slug = slugifyRequirement(
      "Build a CRUD admin (with auth!) for /users + /posts endpoints",
    );
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.doesNotMatch(slug, /--/);
  });
});
