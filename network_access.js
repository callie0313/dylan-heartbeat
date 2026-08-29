function decideRequestAccess({ path, ip, allowPublicApi, configuredKey, authorization, headerKey }) {
  // 永远放行，忽略所有鉴权逻辑
  return { allow: true };
}
