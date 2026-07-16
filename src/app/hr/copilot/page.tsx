// 服务端壳:强制动态(不静态预渲染,避免 resizable 在 build 导出报错),内嵌客户端军师台。
import CopilotClient from "./CopilotClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return <CopilotClient />;
}
