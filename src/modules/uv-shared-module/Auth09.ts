import {BaseEvents} from "./BaseEvents";
import {InformationArgs} from "./InformationArgs";
import {InformationType} from "./InformationType";
import {ILoginDialogueOptions} from "./ILoginDialogueOptions";
import {LoginWarningMessages} from "./LoginWarningMessages";
import IAccessToken = Manifesto.IAccessToken;

export class Auth09 {

    static loadExternalResources(resourcesToLoad: Manifold.ExternalResource[], storageStrategy: string): Promise<Manifold.ExternalResource[]> {
        return new Promise<Manifold.ExternalResource[]>((resolve) => {
            manifesto.Utils.loadExternalResources(
                resourcesToLoad,
                storageStrategy,
                Auth09.clickThrough,
                Auth09.restricted,
                Auth09.login,
                Auth09.getAccessToken,
                Auth09.storeAccessToken,
                Auth09.getStoredAccessToken,
                Auth09.handleExternalResourceResponse).then((r: Manifold.ExternalResource[]) => {
                    resolve(r);
                })['catch']((error: any) => {
                    switch(error.name) {
                        case manifesto.StatusCodes.AUTHORIZATION_FAILED.toString():
                            $.publish(BaseEvents.LOGIN_FAILED);
                            break;
                        case manifesto.StatusCodes.FORBIDDEN.toString():
                            $.publish(BaseEvents.FORBIDDEN);
                            break;
                        case manifesto.StatusCodes.RESTRICTED.toString():
                            // do nothing
                            break;
                        default:
                            $.publish(BaseEvents.SHOW_MESSAGE, [error.message || error]);
                    }
            });
        });
    }

    static clickThrough(resource: Manifold.ExternalResource): Promise<void> {
        return new Promise<void>((resolve) => {

            $.publish(BaseEvents.SHOW_CLICKTHROUGH_DIALOGUE, [{
                resource: resource,
                acceptCallback: () => {
                    const win: Window = window.open(resource.clickThroughService.id);

                    const pollTimer: number = window.setInterval(() => {
                        if (win.closed) {
                            window.clearInterval(pollTimer);
                            $.publish(BaseEvents.CLICKTHROUGH);
                            resolve();
                        }
                    }, 500);
                }
            }]);
        });
    }

    static restricted(resource: Manifold.ExternalResource): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            $.publish(BaseEvents.SHOW_RESTRICTED_DIALOGUE, [{
                resource: resource,
                acceptCallback: () => {
                    $.publish(BaseEvents.LOAD_FAILED);
                    reject(resource);
                }
            }]);
        });
    }

    static login(resource: Manifold.ExternalResource): Promise<void> {
        return new Promise<void>((resolve) => {

            const options: ILoginDialogueOptions = <ILoginDialogueOptions>{};

            if (resource.status === HTTPStatusCode.FORBIDDEN) {
                options.warningMessage = LoginWarningMessages.FORBIDDEN;
                options.showCancelButton = true;
            }

            $.publish(BaseEvents.SHOW_LOGIN_DIALOGUE, [{
                resource: resource,
                loginCallback: () => {
                    const win: Window = window.open(resource.loginService.id + "?t=" + new Date().getTime());
                    const pollTimer: number = window.setInterval(function () {
                        if (win.closed) {
                            window.clearInterval(pollTimer);
                            $.publish(BaseEvents.LOGIN);
                            resolve();
                        }
                    }, 500);
                },
                logoutCallback: () => {
                    const win: Window = window.open(resource.logoutService.id + "?t=" + new Date().getTime());
                    const pollTimer: number = window.setInterval(function () {
                        if (win.closed) {
                            window.clearInterval(pollTimer);
                            $.publish(BaseEvents.LOGOUT);
                            resolve();
                        }
                    }, 500);
                },
                options: options
            }]);
        });
    }

    static getAccessToken(resource: Manifold.ExternalResource, rejectOnError: boolean): Promise<Manifesto.IAccessToken> {

        return new Promise<Manifesto.IAccessToken>((resolve, reject) => {
            const serviceUri: string = resource.tokenService.id;

            // pick an identifier for this message. We might want to keep track of sent messages
            const msgId: string = serviceUri + "|" + new Date().getTime();

            const receiveAccessToken: EventListenerOrEventListenerObject = (e: any) => {
                window.removeEventListener("message", receiveAccessToken);
                const token: any = e.data;
                if (token.error){
                    if(rejectOnError) {
                        reject(token.errorDescription);
                    } else {
                        resolve(undefined);
                    }
                } else {
                    resolve(token);
                }
            };

            window.addEventListener("message", receiveAccessToken, false);

            const tokenUri: string = serviceUri + "?messageId=" + msgId;
            $('#commsFrame').prop('src', tokenUri);
        });
    }

    static storeAccessToken(resource: Manifold.ExternalResource, token: Manifesto.IAccessToken, storageStrategy: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            Utils.Storage.set(resource.tokenService.id, token, token.expiresIn, new Utils.StorageType(storageStrategy));
            resolve();
        });
    }

    static getStoredAccessToken(resource: Manifold.ExternalResource, storageStrategy: string): Promise<Manifesto.IAccessToken> {

        return new Promise<Manifesto.IAccessToken>((resolve, reject) => {

            let foundItems: Utils.StorageItem[] = [];
            let item: Utils.StorageItem | null = null;

            // try to match on the tokenService, if the resource has one:
            if (resource.tokenService) {
                item = Utils.Storage.get(resource.tokenService.id, new Utils.StorageType(storageStrategy));
            }

            if (item) {
                foundItems.push(item);
            } else {
                // find an access token for the domain
                const domain: string = Utils.Urls.getUrlParts(resource.dataUri).hostname;
                const items: Utils.StorageItem[] = Utils.Storage.getItems(new Utils.StorageType(storageStrategy));

                for (let i = 0; i < items.length; i++) {
                    item = items[i];

                    if (item.key.includes(domain)) {
                        foundItems.push(item);
                    }
                }
            }

            // sort by expiresAt, earliest to most recent.
            foundItems = foundItems.sort((a: Utils.StorageItem, b: Utils.StorageItem) => {
                return a.expiresAt - b.expiresAt;
            });

            let foundToken: IAccessToken | undefined;

            if (foundItems.length) {
                foundToken = <Manifesto.IAccessToken>foundItems[foundItems.length - 1].value;
            }

            resolve(foundToken);
        });
    }

    static handleExternalResourceResponse(resource: Manifold.ExternalResource): Promise<any> {

        return new Promise<any>((resolve, reject) => {
            resource.isResponseHandled = true;

            if (resource.status === HTTPStatusCode.OK) {
                resolve(resource);
            } else if (resource.status === HTTPStatusCode.MOVED_TEMPORARILY) {
                resolve(resource);
                $.publish(BaseEvents.RESOURCE_DEGRADED, [resource]);
            } else {

                if (resource.error.status === HTTPStatusCode.UNAUTHORIZED ||
                    resource.error.status === HTTPStatusCode.INTERNAL_SERVER_ERROR) {
                    // if the browser doesn't support CORS
                    if (!Modernizr.cors) {
                        const informationArgs: InformationArgs = new InformationArgs(InformationType.AUTH_CORS_ERROR, null);
                        $.publish(BaseEvents.SHOW_INFORMATION, [informationArgs]);
                        resolve(resource);
                    } else {
                        reject(resource.error.statusText);
                    }
                } else if (resource.error.status === HTTPStatusCode.FORBIDDEN) {
                    const error: Error = new Error();
                    error.message = "Forbidden";
                    error.name = manifesto.StatusCodes.FORBIDDEN.toString();
                    reject(error);
                } else {
                    reject(resource.error.statusText);
                }
            }
        });
    }

    static handleDegraded(resource: Manifold.ExternalResource): void {
        const informationArgs: InformationArgs = new InformationArgs(InformationType.DEGRADED_RESOURCE, resource);
        $.publish(BaseEvents.SHOW_INFORMATION, [informationArgs]);
    }
}