/** Browser hosts may supply environment credentials; native profiles require a host service. */
export function fromNodeProviderChain(options: { profile?: string } = {}) {
  return async () => {
    if (options.profile) throw new Error("AWS profiles require a host credential provider in browser mode")
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    if (!accessKeyId || !secretAccessKey)
      throw new Error("Supply AWS credentials or a Bedrock bearer token in browser mode")
    return {
      accessKeyId,
      secretAccessKey,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    }
  }
}
