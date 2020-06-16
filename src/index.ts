import { OutgoingHttpHeaders } from "http2";
import WebSocket, { CloseEvent, MessageEvent, OpenEvent } from 'ws';
import { URL } from "url";
import { AjusteeHttpClient, HttpMethod } from "./AjusteeHttpClient";

const defaultUrl = 'https://api.ajustee.com/fo';
const defaultWsUrl = 'wss://9b3vnticrc.execute-api.us-west-2.amazonaws.com/ws';

const appIdHeader = 'x-api-key';

export interface AjusteeOverrideParams extends Record<string, string|undefined> 
{
	"ajustee-tracker-id"?: string;
}

export const enum AjusteeClientStatus
{
	Disconnected = "Disconnected",
	Connecting = "Connecting",
	Connected = "Connected",
}

export const enum AjusteeKeyStatus
{
	Unsubscribed = "Unsubscribed",
	Unsubscribing = "Unsubscribing",
	Subscribed = "Subscribed",
	Subscribing = "Subscribing"
}

export const enum DataType
{
	Integer = 'Integer',
	String = 'String',
	Boolean = 'Boolean',
	DateTime = 'DateTime',
	Date = 'Date',
}

export interface ConfigurationKey
{
	path: string;
	dataType: DataType;
	value: string | boolean;
}

export const enum AjusteeKeyListenerCode
{
	Success = 'success',
	KeyNotFound = 'not_found_keypath',
	AppNotFound = 'not_found_app',
	Exists = 'already_exists',
	TypeChanged = 'type_changed',
	KeyDeleted = 'key_deleted',
}

export interface AjusteeKeyListenerBase
{
	readonly path: string 
	dataType?: DataType;
	value?: string|boolean|undefined;
	additionalParams?: AjusteeOverrideParams;
	oldKey?: AjusteeKeyListenerBase;
	status?: AjusteeKeyStatus;

	onChange?(key: AjusteeKeyListenerBase): void;
	onError?(key: AjusteeKeyListenerBase, error: AjusteeKeyListenerCode): void;
}

export interface AjusteeKeyListener<T extends AjusteeKeyListenerBase> extends AjusteeKeyListenerBase
{
	readonly path: string 
	dataType?: DataType;
	value?: string|boolean|undefined;
	additionalParams?: AjusteeOverrideParams;
	oldKey?: T;
	status?: AjusteeKeyStatus;

	onChange?(key: T): void;
	onError?(key: T, error: AjusteeKeyListenerCode): void;
}

export interface AjusteeAllKeysListener<T extends AjusteeKeyListenerBase>
{
	onChange?(keyInfo: T): void;
	onError?(keyInfo: T, error: AjusteeKeyListenerCode): void;
	onSubscriptionChange?(key: T): void;
}

const enum WsResponseType
{
	Subscribe = 'subscribe',
	Unsubscribe = 'unsubscribe',
	Changed = 'changed',
	Deleted = 'deleted'
}

interface WsResponse
{
	type: WsResponseType;
	data?: WsResponseData|ConfigurationKey[]|string;
}

interface WsResponseData
{
	statuscode: AjusteeKeyListenerCode;
	path: string;
}

interface WsRequestSubscrData
{
	action: "subscribe"|"unsubscribe";
	data:
	{
		path: string;
		props?: any;
	};
}

const initialTimeout = 200;

export class AjusteeClient <T extends AjusteeKeyListener<T> = AjusteeKeyListenerBase>
{
	private readonly url: URL;
	private readonly wsUrl: string;
	private readonly ajusteeHttpClient: AjusteeHttpClient;

	private webSocket?: WebSocket;
	private status = AjusteeClientStatus.Disconnected;
	private connectCompletedPromise?: Promise<boolean>;
	private connectCompletedResolve?: (isConnectCompleted: boolean) => void;
	private timeout = initialTimeout;

	private subscribedKeys: Map<string,  T> = new Map();

	allKeysListeners?: AjusteeAllKeysListener<T>;
	statusListener?: (status: AjusteeClientStatus) => void;

	private _appId?: string;

	set appId (value: string|undefined)
	{
		if (value === this._appId) return;
		this._appId = value;
		for (const keyInfo of this.subscribedKeys.values())
		{
			const oldKey = keyInfo.oldKey;
			if (oldKey)
			{
				keyInfo.oldKey = undefined;
				this.setKeyStatus(oldKey, AjusteeKeyStatus.Unsubscribed);
			}
			else this.setKeyStatus(keyInfo, AjusteeKeyStatus.Unsubscribed);
		}
		this.subscribedKeys.clear();
		this.disconnect();
	}

	get appId ()
	{
		return this._appId;
	}


    constructor(url?: string, wsUrl?: string, appId?: string, public defaultParams?: OutgoingHttpHeaders)
    {
		this.url = url ? new URL(url) : new URL(defaultUrl);
		this.wsUrl = wsUrl ? wsUrl : defaultWsUrl;
		this.ajusteeHttpClient = new AjusteeHttpClient(this.url.origin, this.url.pathname.substring(1));
		if (appId) this.appId = appId;
    }

    async connect () 
    {
        await this.ajusteeHttpClient.connect();
    }

    close ()
    {
        this.ajusteeHttpClient.close();
    }

    async getConfigKeys (path?: string, additionalParams?: OutgoingHttpHeaders)
    {
        if (!this.appId) throw new Error('App id is not defined.');
        const requestHeaders = {[appIdHeader]: this.appId};
        if (this.defaultParams) Object.assign(requestHeaders, this.defaultParams);
        if (additionalParams) Object.assign(requestHeaders, additionalParams);
        const response = await this.ajusteeHttpClient.sendRequest (path ? `configurationKeys?path=${path}` : 'configurationKeys', requestHeaders);
        if (response.status !== 200) throw new Error (`Invalid status code: ${response.status}. Content: ${response.content || 'undefined'}`);
        return JSON.parse(response.content!) as ConfigurationKey[];
    }

    private async getConfigKeys2 (path?: string, additionalParams?: OutgoingHttpHeaders )
    {
        if (!this.appId) throw new Error('App id is not defined.');
        const requestHeaders = {[appIdHeader]: this.appId};
        if (this.defaultParams) Object.assign(requestHeaders, this.defaultParams);
        if (additionalParams) Object.assign(requestHeaders, additionalParams);
        const response = await this.ajusteeHttpClient.sendRequest (path ? `config/${path}` : 'config', requestHeaders);
        if (response.status !== 200) throw new Error (`Invalid status code: ${response.status}. Content: ${response.content || 'undefined'}`);
        return JSON.parse(response.content!) as ConfigurationKey[];
	}
	
	async updateConfigKey (path: string, value: string|boolean|number)
	{
		if (!this.appId) throw new Error('App id is not defined.');
		const response = await this.ajusteeHttpClient.sendPayloadRequest(HttpMethod.PUT, `configurationKeys/${path}`,  this.appId, true, JSON.stringify({value: value.toString()}));
		const statusCode = response.status;
		if(statusCode !== 204) throw new Error(`Invalid response code: ${statusCode}`);
	}

		// ws client methods

	setConfigKeyListener(keyInfo: T)
	{
		if (!this.appId) throw new Error('App id is not defined.');

		const currKeyInfo = this.subscribedKeys.get(keyInfo.path);
		if (keyInfo === currKeyInfo) return;

		switch(this.status)
		{
			case AjusteeClientStatus.Disconnected:
			case AjusteeClientStatus.Connecting:
				
				if (currKeyInfo) this.setKeyStatus(currKeyInfo, AjusteeKeyStatus.Unsubscribed);
				else this.setKeyStatus(keyInfo, AjusteeKeyStatus.Subscribing);

				this.subscribedKeys.set(keyInfo.path, keyInfo);
				this.wsConnect();
				return;
				
			case AjusteeClientStatus.Connected:
				if (currKeyInfo)
				{
					const oldKeyInfo = currKeyInfo.oldKey;			
					if (oldKeyInfo)
					{
						if (keyInfo === oldKeyInfo)
						{
							this.setKeyStatus(oldKeyInfo, AjusteeKeyStatus.Subscribing);
							currKeyInfo.oldKey = undefined;
							this.subscribedKeys.set(keyInfo.path, oldKeyInfo);
							return;
						}
						else // substitute currKeyInfo --> keyInfo
						{
							currKeyInfo.oldKey = undefined;
							keyInfo.oldKey = oldKeyInfo;
						}
					}
					else
					{
						keyInfo.oldKey = currKeyInfo;
						switch(currKeyInfo.status)
						{
							case AjusteeKeyStatus.Subscribed:
								this.unsubscribe(currKeyInfo);
							break;
							case AjusteeKeyStatus.Subscribing:
								this.setKeyStatus(currKeyInfo, AjusteeKeyStatus.Unsubscribing);
							break;
						}
					}
				}
				else
				{
					this.subscribe(keyInfo);
				}
				this.subscribedKeys.set(keyInfo.path, keyInfo);
				return;
		}
	}

	getConfigKeyListener (keyPath: string)
	{
		if (!this.appId) throw new Error('App id is not defined.');
		return this.subscribedKeys.get(keyPath);
	}

	removeConfigKeyListener(keyPath: string)
	{
		if (!this.appId) throw new Error('App id is not defined.');
		const keyInfo = this.subscribedKeys.get(keyPath);
		if (!keyInfo)
		{
			console.error(`There is no subscription for the key path '${keyPath}'`)
			return;
		}
		if (keyInfo.oldKey)
		{
			// oldKey is only present when keyInfo.status == Unsubscribed
			// thus we remove keyInfo from the map subscribedKeys 
			// and leave oldKey in the map alone for unsubscription to complete
			this.subscribedKeys.set(keyPath, keyInfo.oldKey);
			keyInfo.oldKey = undefined;
			return;
		}
		switch(keyInfo.status)
		{
			case AjusteeKeyStatus.Unsubscribing: return;

			case AjusteeKeyStatus.Subscribing:

				this.setKeyStatus(keyInfo, AjusteeKeyStatus.Unsubscribing);
				return;

			case AjusteeKeyStatus.Subscribed: 

				if (this.status === AjusteeClientStatus.Connected) 
				{
					this.unsubscribe(keyInfo);
				}
				else 
				{
					this.setKeyStatus(keyInfo, AjusteeKeyStatus.Unsubscribed);
					this.subscribedKeys.delete(keyPath);
					if (this.subscribedKeys.size === 0) this.disconnect();
					else this.wsConnect();
				}
				return;

			default: throw new Error(`Unexpected key info status: ${keyInfo.status}`);
		}
	}

	onError()
	{
		throw new Error('Connection cannot be established.');
	}

	// ws lib methods

	private setKeyStatus (keyInfo: T, status: AjusteeKeyStatus)
	{
		if (keyInfo.status === status) return;
		keyInfo.status = status;
		if (this.allKeysListeners?.onSubscriptionChange) this.allKeysListeners.onSubscriptionChange(keyInfo);
	}

	private setStatus (status: AjusteeClientStatus)
	{
		this.status = status;
		console.log(this.status);
		if (this.statusListener) this.statusListener(status);
	}

	private subscribe (keyInfo: T)
	{
		this.setKeyStatus(keyInfo, AjusteeKeyStatus.Subscribing);

		let params = {};	
		if (this.defaultParams) Object.assign(params, this.defaultParams);
		if (keyInfo.additionalParams) Object.assign(params, keyInfo.additionalParams);

		const data: WsRequestSubscrData = 
		{
			action: "subscribe",
			data:
			{
				path: keyInfo.path,
				props: params
			},
		};
		this.webSocket!.send(JSON.stringify(data));
	}

	private unsubscribe (keyInfo: T)
	{
		this.setKeyStatus(keyInfo, AjusteeKeyStatus.Unsubscribing);

		const data: WsRequestSubscrData =  
		{
			action: "unsubscribe",
			data:
			{
				path: keyInfo.path
			}
		}
		this.webSocket!.send(JSON.stringify(data));
	}

	private initConnection ()
	{
		this.webSocket = new WebSocket(`${this.wsUrl}?x-api-key=${this.appId}`);
		this.webSocket.onopen;
		
		this.webSocket.onopen = this.handleOpen.bind(this);
		this.webSocket.onmessage = this.handleMessage.bind(this);
		this.webSocket.onerror = this.handleError.bind(this);
		this.webSocket.onclose = this.handleClose.bind(this);

		this.connectCompletedPromise = new Promise((resolve)=>{this.connectCompletedResolve = resolve});
		return this.connectCompletedPromise;
	}

	private async wsConnect() 
	{
		this.timeout = initialTimeout;
		if (this.status === AjusteeClientStatus.Connecting) return;
		this.setStatus(AjusteeClientStatus.Connecting);

		// do
		// {
		// 	const isConnected = await this.initConnection();
		// 	if(!isConnected)
		// 	{
		// 		await delay(this.timeout);
		// 		this.timeout = this.timeout * 2;
		// 	}
		// }
		// while (this.status as AjusteeClientStatus === AjusteeClientStatus.Connecting);

		const isConnected = await this.initConnection();
		if (!isConnected) 
		{
			this.subscribedKeys.clear();
			this.onError();
			return;
		}
		
		for (const keyInfo of this.subscribedKeys.values())
		{
			this.subscribe(keyInfo);
		}
		this.timeout = initialTimeout;
	}

	private async disconnect ()
	{
		switch(this.status)
		{
			case AjusteeClientStatus.Disconnected:
				return;

			case AjusteeClientStatus.Connecting:				
				if (!await this.connectCompletedPromise) 
				{
					this.setStatus(AjusteeClientStatus.Disconnected);
					return;
				}				
			break;
		}
		this.webSocket!.onopen = undefined!;
		this.webSocket!.onmessage = undefined!;
		this.webSocket!.onerror = undefined!;
		this.webSocket!.onclose = undefined!;
		this.webSocket!.close();
		this.webSocket = undefined;
		this.setStatus(AjusteeClientStatus.Disconnected);
	}

	private handleOpen (event: OpenEvent)
	{
		// console.log('Connection is opened.', event);
		this.setStatus(AjusteeClientStatus.Connected);

		this.connectCompletedResolve!(true);
		this.connectCompletedResolve = undefined;
		this.connectCompletedPromise = undefined;		
	}

	private handleClose (event: CloseEvent)
	{
		// console.log('Connection is closed.', event);
		this.setStatus(AjusteeClientStatus.Disconnected);

		if (this.subscribedKeys.size > 0)
		{
			for (const keyInfo of this.subscribedKeys.values())
			{
				const oldKey = keyInfo.oldKey;
				if (oldKey) 
				{
					keyInfo.oldKey = undefined;
					this.setKeyStatus(oldKey, AjusteeKeyStatus.Unsubscribed);
				}
				else if (keyInfo.status === AjusteeKeyStatus.Unsubscribing) 
				{
					this.setKeyStatus(keyInfo, AjusteeKeyStatus.Unsubscribed);
					this.subscribedKeys.delete(keyInfo.path);
				}
			}
			setTimeout(this.connect.bind(this), 0);
		}
		
		this.webSocket!.onopen = undefined!;
		this.webSocket!.onmessage = undefined!;
		this.webSocket!.onerror = undefined!;
		this.webSocket!.onclose = undefined!;
		this.webSocket = undefined;
	}

	private handleError (event: WebSocket.ErrorEvent)
	{
		//console.log('Error:', event);

		// this.webSocket!.onopen = null;
		// this.webSocket!.onmessage = null;
		// this.webSocket!.onerror = null;
		// this.webSocket!.onclose = null;
		// this.webSocket = undefined;

		this.connectCompletedResolve!(false);
		this.connectCompletedResolve = undefined;
		this.connectCompletedPromise = undefined;
	}

	private handleMessage (event: MessageEvent)
	{
		// console.log('Message from server:', event);

		const response = (JSON.parse(event.data as string) as WsResponse);

		switch(response.type)
		{
			case WsResponseType.Subscribe:
			{
				const subscrData = (response.data as WsResponseData);
				const subscrKey = this.subscribedKeys.get(subscrData.path);
				if(!subscrKey) 
				{
					console.warn(`Unexpected event ${response.type} for the key path '${subscrData.path}'.`);
					return;
				}

				switch(subscrData.statuscode)
				{
					case AjusteeKeyListenerCode.Success:
						switch(subscrKey.status)
						{
							case AjusteeKeyStatus.Subscribing:
								this.setKeyStatus(subscrKey, AjusteeKeyStatus.Subscribed);						
							break;

							case AjusteeKeyStatus.Unsubscribing:
								this.unsubscribe(subscrKey);
							break;

							case AjusteeKeyStatus.Unsubscribed:
								// the case subscrKey.status == Unsubscribed is the only possible when oldKey is set
								this.unsubscribe(subscrKey.oldKey!);						
							break;
						}
					break;

					case AjusteeKeyListenerCode.Exists:
						console.warn(`The event ${response.type} with the status code ${AjusteeKeyListenerCode.Exists} was received for the key ${subscrKey.path}.`);
					break;

					default:
						const oldKeyInfo = subscrKey.oldKey;
						if (oldKeyInfo) 
						{
							this.setKeyStatus(oldKeyInfo, AjusteeKeyStatus.Unsubscribed);
							subscrKey.oldKey = undefined;
							if (this.allKeysListeners?.onError) this.allKeysListeners.onError(oldKeyInfo, subscrData.statuscode);
							if (oldKeyInfo.onError) oldKeyInfo.onError(oldKeyInfo, subscrData.statuscode);
						}
						else 
						{
							this.setKeyStatus(subscrKey, AjusteeKeyStatus.Unsubscribed);
							if (this.allKeysListeners?.onError) this.allKeysListeners.onError(subscrKey, subscrData.statuscode);
							if (subscrKey.onError) subscrKey.onError(subscrKey, subscrData.statuscode);
						}
						this.subscribedKeys.delete(subscrKey.path);
						if (this.subscribedKeys.size === 0) this.disconnect();
				}
				break;
			}

			case WsResponseType.Unsubscribe:
			{
				const unSubscrData = (response.data as WsResponseData);
				const unsubscrKey = this.subscribedKeys.get(unSubscrData.path);
				if(!unsubscrKey) 
				{
					console.warn(`Unexpected event ${response.type} for the key path '${unSubscrData.path}'.`);
					return;
				}
				const oldKeyInfo = unsubscrKey.oldKey;

				switch(unSubscrData.statuscode)
				{
					case AjusteeKeyListenerCode.Success:
						if (oldKeyInfo) 
						{
							this.setKeyStatus(oldKeyInfo, AjusteeKeyStatus.Unsubscribed);
							unsubscrKey.oldKey = undefined;
							this.subscribe(unsubscrKey);
						}
						else
						{
							switch(unsubscrKey.status)
							{
								case AjusteeKeyStatus.Unsubscribing:
									this.setKeyStatus(unsubscrKey, AjusteeKeyStatus.Unsubscribed);
									this.subscribedKeys.delete(unSubscrData.path);
									if (this.subscribedKeys.size === 0) this.disconnect();
								break;
								case AjusteeKeyStatus.Subscribing:
									this.subscribe(unsubscrKey);
								break;
							}
						}						
					break;

					case AjusteeKeyListenerCode.Exists:
						console.warn(`The event ${response.type} with the status code ${AjusteeKeyListenerCode.Exists} was received for the key ${unsubscrKey.path}.`);
					break;

					default:
						if (oldKeyInfo) 
						{
							this.setKeyStatus(oldKeyInfo, AjusteeKeyStatus.Unsubscribed);
							unsubscrKey.oldKey = undefined;
							if (this.allKeysListeners?.onError) this.allKeysListeners.onError(oldKeyInfo, unSubscrData.statuscode);
							if (oldKeyInfo.onError) oldKeyInfo.onError(oldKeyInfo, unSubscrData.statuscode);
						}
						else 
						{
							this.setKeyStatus(unsubscrKey, AjusteeKeyStatus.Unsubscribed);
							if (this.allKeysListeners?.onError) this.allKeysListeners.onError(unsubscrKey, unSubscrData.statuscode);
							if (unsubscrKey.onError) unsubscrKey.onError(unsubscrKey, unSubscrData.statuscode);
						}
						this.subscribedKeys.delete(unsubscrKey.path);
						if (this.subscribedKeys.size === 0) this.disconnect();
				}
				break;
			}

			case WsResponseType.Changed:
			{ 
				const changedKeys = (response.data as ConfigurationKey[]);

				for (const changedKey of changedKeys)
				{
					const keyInfo = this.subscribedKeys.get(changedKey.path);
					if(!keyInfo)
					{
						console.warn(`Unexpected event ${response.type} for the key path '${changedKey.path}'.`);
						continue;
					} 
					if (keyInfo.oldKey) continue;
					if(!keyInfo.dataType) keyInfo.dataType = changedKey.dataType;
					else if(keyInfo.dataType !== changedKey.dataType)
					{
						keyInfo.dataType = changedKey.dataType;
						if (this.allKeysListeners?.onError) this.allKeysListeners.onError(keyInfo, AjusteeKeyListenerCode.TypeChanged);
						if (keyInfo.onError) keyInfo.onError(keyInfo, AjusteeKeyListenerCode.TypeChanged);
						return;
					}

					if (keyInfo.value !== changedKey.value)
					{
						keyInfo.value = changedKey.value;
						if (this.allKeysListeners?.onChange) this.allKeysListeners.onChange(keyInfo);
						if (keyInfo.onChange) keyInfo.onChange(keyInfo);
					}
				}
				break;
			}

			case WsResponseType.Deleted: 
			{
				const deletedKeyPath = (response.data as string);
				const deletedKey = this.subscribedKeys.get(deletedKeyPath);
				if(!deletedKey) 
				{
					console.warn(`Unexpected event ${response.type} for the key path '${deletedKeyPath}'.`);
					return;
				}

				if (this.allKeysListeners?.onError) this.allKeysListeners.onError(deletedKey, AjusteeKeyListenerCode.KeyDeleted);
				if (deletedKey.onError) deletedKey.onError(deletedKey, AjusteeKeyListenerCode.KeyDeleted);

				this.subscribedKeys.delete(deletedKeyPath);
				if (this.subscribedKeys.size === 0) this.disconnect();
				break;
			}

			default: console.warn('Unexpected event:', response);
		}
	}
}

function delay (time: number)
{
	return new Promise((resolve)=>
	{
		setTimeout(resolve, time);
	});
}