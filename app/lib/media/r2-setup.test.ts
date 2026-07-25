import { describe, expect, it } from "vitest";
import { r2SetupReady } from "./r2-setup";

const complete = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucketName: "socialite-staging",
  accessKeyId: "access",
  secretAccessKey: "secret",
  lifecycleAcknowledged: true,
};

describe("guided R2 setup", () => {
  it("enables verification only after credentials and lifecycle acknowledgement are present", () => {
    expect(r2SetupReady(complete)).toBe(true);
    expect(r2SetupReady({ ...complete, secretAccessKey: "" })).toBe(false);
    expect(r2SetupReady({ ...complete, lifecycleAcknowledged: false })).toBe(false);
  });
});
