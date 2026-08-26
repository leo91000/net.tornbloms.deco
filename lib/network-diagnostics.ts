export interface NetworkReachability {
  sameSubnet: boolean;
  httpReachable: boolean;
  httpsReachable: boolean;
}

export function describeNetworkReachability({
  sameSubnet,
  httpReachable,
  httpsReachable,
}: NetworkReachability): string {
  if (sameSubnet) {
    return 'direct subnet match';
  }
  if (httpReachable || httpsReachable) {
    return 'different local/container subnet, but routed reachability is confirmed';
  }
  return 'different subnet and router ports are unreachable';
}
