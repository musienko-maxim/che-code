/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { ResourceMap } from 'vs/base/common/map';
import { URI, UriComponents } from 'vs/base/common/uri';
import { Metadata, isIExtensionIdentifier } from 'vs/platform/extensionManagement/common/extensionManagement';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IExtension, IExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { FileOperationResult, IFileService, toFileOperationResult } from 'vs/platform/files/common/files';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { IUserDataProfilesService } from 'vs/platform/userDataProfile/common/userDataProfile';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { Mutable, isObject, isString, isUndefined } from 'vs/base/common/types';
import { getErrorMessage } from 'vs/base/common/errors';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

interface IStoredProfileExtension {
	identifier: IExtensionIdentifier;
	location: UriComponents | string;
	relativeLocation: string | undefined;
	version: string;
	metadata?: Metadata;
}

export const enum ExtensionsProfileScanningErrorCode {

	/**
	 * Error when trying to scan extensions from a profile that does not exist.
	 */
	ERROR_PROFILE_NOT_FOUND = 'ERROR_PROFILE_NOT_FOUND',

	/**
	 * Error when profile file is invalid.
	 */
	ERROR_INVALID_CONTENT = 'ERROR_INVALID_CONTENT',

}

export class ExtensionsProfileScanningError extends Error {
	constructor(message: string, public code: ExtensionsProfileScanningErrorCode) {
		super(message);
	}
}

export interface IScannedProfileExtension {
	readonly identifier: IExtensionIdentifier;
	readonly version: string;
	readonly location: URI;
	readonly metadata?: Metadata;
}

export interface ProfileExtensionsEvent {
	readonly extensions: readonly IScannedProfileExtension[];
	readonly profileLocation: URI;
}

export interface DidAddProfileExtensionsEvent extends ProfileExtensionsEvent {
	readonly error?: Error;
}

export interface DidRemoveProfileExtensionsEvent extends ProfileExtensionsEvent {
	readonly error?: Error;
}

export interface IProfileExtensionsScanOptions {
	readonly bailOutWhenFileNotFound?: boolean;
}

export const IExtensionsProfileScannerService = createDecorator<IExtensionsProfileScannerService>('IExtensionsProfileScannerService');
export interface IExtensionsProfileScannerService {
	readonly _serviceBrand: undefined;

	readonly onAddExtensions: Event<ProfileExtensionsEvent>;
	readonly onDidAddExtensions: Event<DidAddProfileExtensionsEvent>;
	readonly onRemoveExtensions: Event<ProfileExtensionsEvent>;
	readonly onDidRemoveExtensions: Event<DidRemoveProfileExtensionsEvent>;

	scanProfileExtensions(profileLocation: URI, options?: IProfileExtensionsScanOptions): Promise<IScannedProfileExtension[]>;
	addExtensionsToProfile(extensions: [IExtension, Metadata | undefined][], profileLocation: URI): Promise<IScannedProfileExtension[]>;
	updateMetadata(extensions: [IExtension, Metadata | undefined][], profileLocation: URI): Promise<IScannedProfileExtension[]>;
	removeExtensionFromProfile(extension: IExtension, profileLocation: URI): Promise<void>;
}

export abstract class AbstractExtensionsProfileScannerService extends Disposable implements IExtensionsProfileScannerService {
	readonly _serviceBrand: undefined;

	private readonly _onAddExtensions = this._register(new Emitter<ProfileExtensionsEvent>());
	readonly onAddExtensions = this._onAddExtensions.event;

	private readonly _onDidAddExtensions = this._register(new Emitter<DidAddProfileExtensionsEvent>());
	readonly onDidAddExtensions = this._onDidAddExtensions.event;

	private readonly _onRemoveExtensions = this._register(new Emitter<ProfileExtensionsEvent>());
	readonly onRemoveExtensions = this._onRemoveExtensions.event;

	private readonly _onDidRemoveExtensions = this._register(new Emitter<DidRemoveProfileExtensionsEvent>());
	readonly onDidRemoveExtensions = this._onDidRemoveExtensions.event;

	private readonly resourcesAccessQueueMap = new ResourceMap<Queue<IScannedProfileExtension[]>>();

	constructor(
		private readonly extensionsLocation: URI,
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	scanProfileExtensions(profileLocation: URI, options?: IProfileExtensionsScanOptions): Promise<IScannedProfileExtension[]> {
		return this.withProfileExtensions(profileLocation, undefined, options);
	}

	async addExtensionsToProfile(extensions: [IExtension, Metadata | undefined][], profileLocation: URI): Promise<IScannedProfileExtension[]> {
		const extensionsToRemove: IScannedProfileExtension[] = [];
		const extensionsToAdd: IScannedProfileExtension[] = [];
		try {
			await this.withProfileExtensions(profileLocation, profileExtensions => {
				const result: IScannedProfileExtension[] = [];
				for (const extension of profileExtensions) {
					if (extensions.some(([e]) => areSameExtensions(e.identifier, extension.identifier) && e.manifest.version !== extension.version)) {
						// Remove the existing extension with different version
						extensionsToRemove.push(extension);
					} else {
						result.push(extension);
					}
				}
				for (const [extension, metadata] of extensions) {
					if (!result.some(e => areSameExtensions(e.identifier, extension.identifier) && e.version === extension.manifest.version)) {
						// Add only if the same version of the extension is not already added
						const extensionToAdd = { identifier: extension.identifier, version: extension.manifest.version, location: extension.location, metadata };
						extensionsToAdd.push(extensionToAdd);
						result.push(extensionToAdd);
					}
				}
				if (extensionsToAdd.length) {
					this._onAddExtensions.fire({ extensions: extensionsToAdd, profileLocation });
				}
				if (extensionsToRemove.length) {
					this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
				}
				return result;
			});
			if (extensionsToAdd.length) {
				this._onDidAddExtensions.fire({ extensions: extensionsToAdd, profileLocation });
			}
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
			}
			return extensionsToAdd;
		} catch (error) {
			if (extensionsToAdd.length) {
				this._onDidAddExtensions.fire({ extensions: extensionsToAdd, error, profileLocation });
			}
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, error, profileLocation });
			}
			throw error;
		}
	}

	async updateMetadata(extensions: [IExtension, Metadata][], profileLocation: URI): Promise<IScannedProfileExtension[]> {
		const updatedExtensions: IScannedProfileExtension[] = [];
		await this.withProfileExtensions(profileLocation, profileExtensions => {
			const result: IScannedProfileExtension[] = [];
			for (const profileExtension of profileExtensions) {
				const extension = extensions.find(([e]) => areSameExtensions(e.identifier, profileExtension.identifier) && e.manifest.version === profileExtension.version);
				if (extension) {
					profileExtension.metadata = { ...profileExtension.metadata, ...extension[1] };
					updatedExtensions.push(profileExtension);
					result.push(profileExtension);
				} else {
					result.push(profileExtension);
				}
			}
			return result;
		});
		return updatedExtensions;
	}

	async removeExtensionFromProfile(extension: IExtension, profileLocation: URI): Promise<void> {
		const extensionsToRemove: IScannedProfileExtension[] = [];
		this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
		try {
			await this.withProfileExtensions(profileLocation, profileExtensions => {
				const result: IScannedProfileExtension[] = [];
				for (const e of profileExtensions) {
					if (areSameExtensions(e.identifier, extension.identifier)) {
						extensionsToRemove.push(e);
					} else {
						result.push(e);
					}
				}
				if (extensionsToRemove.length) {
					this._onRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
				}
				return result;
			});
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, profileLocation });
			}
		} catch (error) {
			if (extensionsToRemove.length) {
				this._onDidRemoveExtensions.fire({ extensions: extensionsToRemove, error, profileLocation });
			}
			throw error;
		}
	}

	private async withProfileExtensions(file: URI, updateFn?: (extensions: Mutable<IScannedProfileExtension>[]) => IScannedProfileExtension[], options?: IProfileExtensionsScanOptions): Promise<IScannedProfileExtension[]> {
		return this.getResourceAccessQueue(file).queue(async () => {
			let extensions: IScannedProfileExtension[] = [];

			// Read
			let storedProfileExtensions: IStoredProfileExtension[] | undefined;
			try {
				const content = await this.fileService.readFile(file);
				storedProfileExtensions = JSON.parse(content.value.toString().trim() || '[]');
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
					throw error;
				}
				// migrate from old location, remove this after couple of releases
				if (this.uriIdentityService.extUri.isEqual(file, this.userDataProfilesService.defaultProfile.extensionsResource)) {
					storedProfileExtensions = await this.migrateFromOldDefaultProfileExtensionsLocation();
				}
				if (!storedProfileExtensions && options?.bailOutWhenFileNotFound) {
					throw new ExtensionsProfileScanningError(getErrorMessage(error), ExtensionsProfileScanningErrorCode.ERROR_PROFILE_NOT_FOUND);
				}
			}
			if (storedProfileExtensions) {
				if (!Array.isArray(storedProfileExtensions)) {
					this.reportAndThrowInvalidConentError(file);
				}
				// TODO @sandy081: Remove this migration after couple of releases
				let migrate = false;
				for (const e of storedProfileExtensions) {
					if (!isStoredProfileExtension(e)) {
						this.reportAndThrowInvalidConentError(file);
					}
					let location: URI;
					if (isString(e.relativeLocation) && e.relativeLocation) {
						// Extension in new format. No migration needed.
						location = this.resolveExtensionLocation(e.relativeLocation);
					} else if (isString(e.location)) {
						// Extension in intermediate format. Migrate to new format.
						location = this.resolveExtensionLocation(e.location);
						migrate = true;
						e.relativeLocation = e.location;
						// retain old format so that old clients can read it
						e.location = location.toJSON();
					} else {
						location = URI.revive(e.location);
						const relativePath = this.toRelativePath(location);
						if (relativePath) {
							// Extension in old format. Migrate to new format.
							migrate = true;
							e.relativeLocation = relativePath;
						}
					}
					extensions.push({
						identifier: e.identifier,
						location,
						version: e.version,
						metadata: e.metadata,
					});
				}
				if (migrate) {
					await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)));
				}
			}

			// Update
			if (updateFn) {
				extensions = updateFn(extensions);
				const storedProfileExtensions: IStoredProfileExtension[] = extensions.map(e => ({
					identifier: e.identifier,
					version: e.version,
					// retain old format so that old clients can read it
					location: e.location.toJSON(),
					relativeLocation: this.toRelativePath(e.location),
					metadata: e.metadata
				}));
				await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)));
			}

			return extensions;
		});
	}

	private reportAndThrowInvalidConentError(file: URI): void {
		type ErrorClassification = {
			owner: 'sandy081';
			comment: 'Information about the error that occurred while scanning';
			code: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'error code' };
		};
		const error = new ExtensionsProfileScanningError(`Invalid extensions content in ${file.toString()}`, ExtensionsProfileScanningErrorCode.ERROR_INVALID_CONTENT);
		this.telemetryService.publicLogError2<{ code: string }, ErrorClassification>('extensionsProfileScanningError', { code: error.code });
		throw error;
	}

	private toRelativePath(extensionLocation: URI): string | undefined {
		return this.uriIdentityService.extUri.isEqualOrParent(extensionLocation, this.extensionsLocation)
			? this.uriIdentityService.extUri.relativePath(this.extensionsLocation, extensionLocation)
			: undefined;
	}

	private resolveExtensionLocation(path: string): URI {
		return this.uriIdentityService.extUri.joinPath(this.extensionsLocation, path);
	}

	private _migrationPromise: Promise<IStoredProfileExtension[] | undefined> | undefined;
	private async migrateFromOldDefaultProfileExtensionsLocation(): Promise<IStoredProfileExtension[] | undefined> {
		if (!this._migrationPromise) {
			this._migrationPromise = (async () => {
				const oldDefaultProfileExtensionsLocation = this.uriIdentityService.extUri.joinPath(this.userDataProfilesService.defaultProfile.location, 'extensions.json');
				const oldDefaultProfileExtensionsInitLocation = this.uriIdentityService.extUri.joinPath(this.extensionsLocation, '.init-default-profile-extensions');
				let content: string;
				try {
					content = (await this.fileService.readFile(oldDefaultProfileExtensionsLocation)).value.toString();
				} catch (error) {
					if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
						return undefined;
					}
					throw error;
				}

				this.logService.info('Migrating extensions from old default profile location', oldDefaultProfileExtensionsLocation.toString());
				let storedProfileExtensions: IStoredProfileExtension[] | undefined;
				try {
					const parsedData = JSON.parse(content);
					if (Array.isArray(parsedData) && parsedData.every(candidate => isStoredProfileExtension(candidate))) {
						storedProfileExtensions = parsedData;
					} else {
						this.logService.warn('Skipping migrating from old default profile locaiton: Found invalid data', parsedData);
					}
				} catch (error) {
					/* Ignore */
					this.logService.error(error);
				}

				if (storedProfileExtensions) {
					try {
						await this.fileService.createFile(this.userDataProfilesService.defaultProfile.extensionsResource, VSBuffer.fromString(JSON.stringify(storedProfileExtensions)), { overwrite: false });
						this.logService.info('Migrated extensions from old default profile location to new location', oldDefaultProfileExtensionsLocation.toString(), this.userDataProfilesService.defaultProfile.extensionsResource.toString());
					} catch (error) {
						if (toFileOperationResult(error) === FileOperationResult.FILE_MODIFIED_SINCE) {
							this.logService.info('Migration from old default profile location to new location is done by another window', oldDefaultProfileExtensionsLocation.toString(), this.userDataProfilesService.defaultProfile.extensionsResource.toString());
						} else {
							throw error;
						}
					}
				}

				try {
					await this.fileService.del(oldDefaultProfileExtensionsLocation);
				} catch (error) {
					if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
						this.logService.error(error);
					}
				}

				try {
					await this.fileService.del(oldDefaultProfileExtensionsInitLocation);
				} catch (error) {
					if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
						this.logService.error(error);
					}
				}

				return storedProfileExtensions;
			})();
		}
		return this._migrationPromise;
	}

	private getResourceAccessQueue(file: URI): Queue<IScannedProfileExtension[]> {
		let resourceQueue = this.resourcesAccessQueueMap.get(file);
		if (!resourceQueue) {
			resourceQueue = new Queue<IScannedProfileExtension[]>();
			this.resourcesAccessQueueMap.set(file, resourceQueue);
		}
		return resourceQueue;
	}
}

function isStoredProfileExtension(candidate: any): candidate is IStoredProfileExtension {
	return isObject(candidate)
		&& isIExtensionIdentifier(candidate.identifier)
		&& (isUriComponents(candidate.location) || (isString(candidate.location) && candidate.location))
		&& (isUndefined(candidate.relativeLocation) || isString(candidate.relativeLocation))
		&& candidate.version && isString(candidate.version);
}

function isUriComponents(thing: unknown): thing is UriComponents {
	if (!thing) {
		return false;
	}
	return isString((<any>thing).path) &&
		isString((<any>thing).scheme);
}
