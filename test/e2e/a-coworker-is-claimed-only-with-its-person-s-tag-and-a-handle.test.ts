import { expect, test } from "bun:test";
import { E2E, harbor, said, say, startBuzz, startFirm } from "../kit";

const keyIn = (made: string) => (/its Buzz key is ([0-9a-f]{64})/.exec(made) as string[])[1] as string;

test(
  "a coworker is claimed only with a tag its person's Buzz key signed for it, and only once it is for someone: until then it is not in Buzz, and once claimed it is",
  async () => {
    await using buzz = await startBuzz();
    await using firm = await startFirm({ buzz });
    firm.model.on(said("Who are you for?"), say("For you, Rosa."));

    // An admin makes a coworker for nobody yet; duck gives it a Buzz key of its own.
    const finch = keyIn(await firm.duck("make", "finch"));
    expect(finch).not.toBe(buzz.keys.wren);
    await expect(firm.duck("make", "finch")).rejects.toThrow("duck has made coworker finch already");
    await expect(
      firm.duck("claim", "finch", buzz.tagFor(buzz.keys.wren), "Theo Grant", "theo"),
    ).rejects.toThrow("the claim's tag does not sign coworker finch's Buzz key");
    await expect(firm.duck("claim", "finch", buzz.tagFor(finch), "Theo Grant")).rejects.toThrow(
      "coworker finch is for nobody yet",
    );
    await expect(
      firm.duck("claim", "finch", buzz.tagFor(finch), "Theo Grant", harbor.person),
    ).rejects.toThrow(`coworker ${harbor.coworker} is already for ${harbor.person}`);
    expect(await buzz.presence(finch)).not.toBe("online");

    // The coworker claimed when the firm started answers its person in Buzz.
    await buzz.person.online();
    await buzz.person.send("Who are you for?");
    expect((await buzz.person.next(60)).content).toBe("For you, Rosa.");

    await expect(firm.duck("claim", "finch", buzz.tagFor(finch), " ", "theo")).rejects.toThrow(
      "the claim gives no name for coworker finch's person",
    );
    await firm.duck("claim", "finch", buzz.tagFor(finch), "Theo Grant", "theo");
    await buzz.person.online(60, finch);
    await expect(firm.duck("claim", "finch", buzz.tagFor(finch), "Theo Grant", "theo")).rejects.toThrow(
      "coworker finch is claimed already",
    );
  },
  E2E,
);
