import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Refresher } from './semantic-refresh.ts';
import type { VaultProvider } from './types.ts';
export interface WebServerService {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface WikiHost {
    webServer: WebServerService;
}
export interface WikiRoutesDeps {
    /** 测试注入点：替换语义刷新器（默认真实实现，会读写 ~/.dsh/qmd）。 */
    refresherFor?: (vaultRoot: string) => Pick<Refresher, 'status' | 'refreshNow'>;
}
export declare function mountWikiRoutes(host: WikiHost, provider: VaultProvider, deps?: WikiRoutesDeps): () => void;
