import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "opencode",
  cliBackendIds: ["opencode-cli"],
  providerIds: ["opencode"],
  mediaUnderstandingProviderIds: ["opencode"],
  requireDescribeImages: true,
});
