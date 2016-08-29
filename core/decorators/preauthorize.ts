﻿import {MetaUtils} from "../metadata/utils";
import {Decorators} from '../constants/decorators';
import {DecoratorType} from '../enums/decorator-type';
import {IPreauthorizeParams} from './interfaces/preauthorize-params';
import {PrincipalContext} from '../../security/auth/principalContext';
import {PreAuthService} from '../services/pre-auth-service';
import {pathRepoMap, getEntity, getModel} from '../dynamic/model-entity';
import {InstanceService} from '../services/instance-service';
import * as Utils from '../utils';
import {RepoActions} from '../enums/repo-actions-enum';
var Q = require('q');

export function preauthorize(params: IPreauthorizeParams): any {
    params = params || <any>{};

    return function (target: Function, propertyKey: string, descriptor: any) {
        MetaUtils.addMetaData(target,
            {
                decorator: Decorators.PREAUTHORIZE,
                decoratorType: DecoratorType.METHOD,
                params: params,
                propertyKey: propertyKey
            });

        var originalMethod = descriptor.value;

        descriptor.value = function () {
            var anonymous = MetaUtils.getMetaData(target, Decorators.ALLOWANONYMOUS, propertyKey);
            if (anonymous) return originalMethod.apply(this, arguments);
            let args = [];
            args = Array.apply(null, arguments);

            // merge logic
            return mergeEntity.apply(this, [args, originalMethod]).then(mergedEntities => {
                let fullyQualifiedEntities = []; // hetrogenious obj
                // for bulk action case
                if (args[0] instanceof Array) {
                    mergedEntities.forEach(e => {
                        fullyQualifiedEntities.push(e.value);
                    });
                }
                else {
                    // for single action
                    fullyQualifiedEntities = mergedEntities[0].value;
                }

                return PreAuthService.isPreAuthenticated([fullyQualifiedEntities], params, propertyKey).then(isAllowed => {
                    //req.body = fullyQualifiedEntities;
                    if (isAllowed) {
                        // for delete, post action no need to save merged entity else save merged entity to db
                        if (originalMethod.name.toUpperCase() != RepoActions.delete.toUpperCase() && originalMethod.name.toUpperCase() != RepoActions.patch.toUpperCase()) {
                            args[args.length - 1] = fullyQualifiedEntities;
                        }
                        return originalMethod.apply(this, args);
                        //return originalMethod.apply(this, [fullyQualifiedEntities]);
                    }
                    else {
                        var error = 'unauthorize access for resource';
                        var res = PrincipalContext.get('res');
                        if (res) {
                            res.set("Content-Type", "application/json");
                            res.send(403, JSON.stringify(error, null, 4));
                        }
                        throw null;
                    }
                });
            });
        }
        return descriptor;
    }
}

function mergeEntity(args: any, method: any): Q.Promise<any> {
    var entity = args[0];
    var asyncCalls = [];
    // check if entity is array that means it is the bulk action case
    if (entity instanceof Array) {
        entity.forEach(e => {
            asyncCalls.push(mergeTask.apply(this, [e, method]));
        });
    }
    else {
        asyncCalls.push(mergeTask.apply(this, [args, method])); // args[0] is "id" and args[1] is "entity"
    }

    return Q.allSettled(asyncCalls).then(success => {
        return success;
    }).catch(error => {
        throw error;
    });
}

function mergeTask(args: any, method: any): Q.Promise<any> {

    switch (method.name.toUpperCase()) {
        // for post action
        case RepoActions.post.toUpperCase():
            let newDbEntityObj = InstanceService.getInstance(this.getEntity(), null, args[0]);
            return Q.when(newDbEntityObj);

        // for delete action find id from req.params and return db object directly, no need to merge
        case RepoActions.delete.toUpperCase():
            return this.findOne(args[0]).then(dbEntity => {
                return Q.when(dbEntity);
            });

        // for patch action find id from req.params and return db object directly, no need to merge
        case RepoActions.patch.toUpperCase():
            return this.findOne(args[0]).then(dbEntity => {
                return Q.when(dbEntity);
            });

        // for other actions find corresponding entity from db and merge it
        default:
            let id;
            let entity;
            if (args instanceof Array) {
                id = args[0];
                entity = args[1];
            }
            else {
                entity = args;
                id = entity._id;
            }
            return this.findOne(id).then(dbEntity => {
                // merge res body entity with db entity
                if (entity) {
                    for (var prop in entity){
                        dbEntity[prop] = entity[prop];
                    }
                    dbEntity = InstanceService.getInstance(this.getEntity(), null, dbEntity);
                }
                return Q.when(dbEntity);
            });
    }
}
