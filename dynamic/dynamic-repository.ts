﻿/// <reference path="../typings/mongoose/mongoose.d.ts" />
/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/q/Q.d.ts" />
/// <reference path="../typings/linq/linq.3.0.3-Beta4.d.ts" />

var Enumerable: linqjs.EnumerableStatic = require('linq');
var http = require("http");
var express = require("express");
var router = express.Router();

import Q = require('q');
import * as Config from '../config';

import Mongoose = require("mongoose");
Mongoose.connect(Config.Data.DbConnection);
var MongooseSchema = Mongoose.Schema;
import * as MetaUtils from "../decorators/metadata/utils";
import * as Utils from "../utils/utils";

var repoList: { [key: string]: any } = {};
var modelNameRepoModelMap: { [key: string]: IDynamicRepository } = {};

interface IDynamicRepository {
    getModel();
    addRel();
    modelName();
    put(id: any, obj: any): Q.Promise<any>;
    post(obj: any): Q.Promise<any>;
    findOne(id: any);
    findMany(ids: Array<any>);
}

export class DynamicRepository {
    private path: string;
    private model: Mongoose.Model<any>;
    private metaModel: any;
    private entityType: any;
    private modelRepo: any;

    constructor(repositoryPath: string, fn: Function, schema: any, modelRepo: any) {
        this.path = repositoryPath;
        var modelName = this.path.substring(1);
        this.entityType = fn;
        //this.metaModel=new this.entityType();
        repoList[this.path] = repoList[this.path] || Mongoose.model(repositoryPath, schema);
        this.model = repoList[this.path];
        modelNameRepoModelMap[this.path] = this;
        this.modelRepo = modelRepo;
    }

    public getModelRepo() {
        return this.modelRepo;
    }

    public getModel() {
        return this.model;
    }

    public addRel() {
        //var user1 = new this.model({"_id": Math.random() + new Date().toString() + this.path + "1", 'name': 'u1' });
        //var user2 = new this.model({ "_id": Math.random() + new Date().toString() + this.path + "2", 'name': 'u2' });
        //this.model.create([user1, user2]).then((msg) => {
        //    console.log(msg);
        //}, (e) => {
        //    console.log(e);
        //});
    }

    public saveObjs(objArr: Array<any>) {
        return this.model.create(objArr).then((msg) => {
            console.log(msg);
        }, (e) => {
            console.log(e);
        });
    }

    public modelName() {
        return this.model.modelName;
    }

    public getEntityType() {
        return this.entityType;
    }

    public findAll(): Q.Promise<any> {
        return Q.nbind(this.model.find, this.model)({})
            .then(result => {
                return this.toObject(result);
            });;
    }

    public findWhere(query): Q.Promise<any> {
        return Q.nbind(this.model.find, this.model)(query);
    }

    public findOne(id) {
        return Q.nbind(this.model.findOne, this.model)({ '_id': id })
            .then(result => {
                return this.toObject(result);
            });;
    }

    public findByField(fieldName, value): Q.Promise<any> {
        var param = {};
        param[fieldName] = value;
        return Q.nbind(this.model.findOne, this.model)(param)
            .then(result => {
                return this.toObject(result);
            });
    }

    public findMany(ids: Array<any>) {
        return Q.nbind(this.model.find, this.model)({
            '_id': {
                $in: ids
            }
        }).then(result => {
            return this.toObject(result);
        });
    }

    public findChild(id, prop) {
        var deferred = Q.defer();
        this.model.findOne({ '_id': id }, (err, res) => {
            if (err) {
                return deferred.reject(err);
            }
            return deferred.resolve(res);
        });
        return deferred.promise;

    }

    /**
     * case 1: all new - create main item and child separately and embed if true
     * case 2: some new, some update - create main item and update/create child accordingly and embed if true
     * @param obj
     */
    public post(obj: any): Q.Promise<any> {
        return this.processEmbedding(obj)
            .then(result => {
                var primaryKeyMeta = MetaUtils.getPrimaryKeyMetadata(this.entityType);
                var primaryKeyParams: MetaUtils.IFieldParams = primaryKeyMeta.params;
                if (primaryKeyParams.autogenerated) {
                    var objectId = new Mongoose.Types.ObjectId();
                    if (primaryKeyMeta.propertyType.itemType === String) {
                        obj[primaryKeyMeta.propertyKey] = objectId.toHexString();
                    } else if (primaryKeyMeta.propertyType.itemType === Mongoose.Types.ObjectId) {
                        obj[primaryKeyMeta.propertyKey] = objectId;
                    } else {
                        throw 'Autogenerated type can be string or objectId';
                    }
                }
                return Q.nbind(this.model.create, this.model)(new this.model(obj));
            });
    }

    public put(id: any, obj: any) {
        return Q.nbind(this.model.findOneAndUpdate, this.model)({ '_id': id }, obj, { upsert: true });
    }

    public delete(id: any) {
        return Q.nbind(this.model.findOneAndRemove, this.model)({ '_id': id });
    }

    public patch(id: any, obj) {
        return Q.nbind(this.model.findOneAndUpdate, this.model)({ '_id': id });
    }

    private merge(source, dest) {
        for (var key in source) {
            if (!dest[key] || dest[key] != source[key]) {
                dest[key] = source[key];
            }
        }
    }

    private updateEmbeddedOnEntityChange() {

    }

    private processEmbedding(obj: any) {
        var asyncCalls = [];
        for (var prop in obj) {
            var metaArr = MetaUtils.getAllMetaDataForField(this.entityType, prop);
            var relationDecoratorMeta: [MetaUtils.MetaData] = <any>Enumerable.from(metaArr).where((x: MetaUtils.MetaData) => Utils.isRelationDecorator(x.decorator)).toArray();
            if (!relationDecoratorMeta || relationDecoratorMeta.length == 0) {
                continue;
            }
            if (relationDecoratorMeta.length > 1) {
                throw 'too many relations in single model';
            }
            var params = <MetaUtils.IAssociationParams>relationDecoratorMeta[0].params;
            if (params.embedded) {
                asyncCalls.push(this.embedChild(obj, prop, relationDecoratorMeta[0]));
            } else if (!params.persist) {
                delete obj[prop];
                continue;
            }
        }
        return Q.allSettled(asyncCalls);
    }

    private embedChild(obj, prop, relMetadata: MetaUtils.MetaData): Q.Promise<any> {
        if (!obj[prop] || (obj[prop] instanceof Array && obj[prop].length == 0)) {
            return Q.when();
        }
        if (relMetadata.propertyType.isArray && !(obj[prop] instanceof Array)) {
            throw 'Expected array, found non-array';
        }
        if (!relMetadata.propertyType.isArray && (obj[prop] instanceof Array)) {
            throw 'Expected single item, found array';
        }
        var params: MetaUtils.IAssociationParams = <any>relMetadata.params;

        var repo = modelNameRepoModelMap[params.rel];
        if (!repo) {
            throw 'no repository found for relation';
        }

        return repo.findMany(this.castAndGetPrimaryKeys(obj, prop, relMetadata))
            .then(result => {
                obj[prop] = obj[prop] instanceof Array ? result : result[0];
            }).catch(error => {
                console.error(error);
                return Q.reject(error);
            });
    }

    private castAndGetPrimaryKeys(obj, prop, relMetaData: MetaUtils.MetaData): Array<any> {
        var primaryMetaDataForRelation = MetaUtils.getPrimaryKeyMetadata(relMetaData.target);

        if (!primaryMetaDataForRelation) {
            throw 'primary key not found for relation';
        }

        var primaryType = primaryMetaDataForRelation.propertyType.itemType;
        return obj[prop] instanceof Array
            ? Enumerable.from(obj[prop]).select(x => Utils.castToMongooseType(x, primaryType)).toArray()
            : [Utils.castToMongooseType(obj, primaryType)];
    }


    //private saveChildren(obj: any): Q.Promise<any> {
    //    var asyncCalls = [];
    //    for (var prop in obj) {
    //        var metaArr = MetaUtils.getAllMetaDataForField(this.entityType, prop);
    //        var relationDecoratorMeta = Enumerable.from(metaArr).where((x: MetaUtils.MetaData) => this.isRelationDecorator(x.decorator)).toArray();
    //        if (!relationDecoratorMeta || relationDecoratorMeta.length == 0) {
    //            continue;
    //        }
    //        if (relationDecoratorMeta.length > 1) {
    //            throw 'too many relations in single model';
    //        }
    //        this.saveEmbedded(obj, prop);
    //    }
    //    return Q.allSettled(asyncCalls);
    //}

    //private saveEmbedded(obj, prop) {
    //    var repo = modelNameRepoModelMap[prop];
    //    if (!repo) {
    //        throw 'no repository found for relation';
    //    }
    //    var objArr: Array<any> = obj[prop];
    //    var putAllPromise = this.putAll(Enumerable.from(objArr).where(x => x['_id']).toArray(), repo);
    //    var postAllPromise = this.postAll(Enumerable.from(objArr).where(x => !x['_id']).toArray(), repo);
    //    return Q.allSettled([putAllPromise, postAllPromise])
    //        .then(result => {
    //            console.log(result);
    //        });
    //}

    //private postAll(objArr: Array<any>, repo): Q.Promise<any> {
    //    if (!objArr || !objArr.length) {
    //        return Q.when();
    //    }
    //    var asyncCalls = [];
    //    Enumerable.from(objArr).forEach(x => {
    //        asyncCalls.push(repo.post(x));
    //    });
    //    return Q.allSettled(asyncCalls);
    //}

    //private putAll(objArr: Array<any>, repo): Q.Promise<any> {
    //    if (!objArr || !objArr.length) {
    //        return Q.when();
    //    }
    //    var asyncCalls = [];
    //    Enumerable.from(objArr).forEach(x => {
    //        asyncCalls.push(repo.put(x));
    //    });
    //    return Q.allSettled(asyncCalls);
    //}



    private toObject(result): any {
        if (result instanceof Array) {
            return Enumerable.from(result).select(x => x.toObject()).toArray();
        }
        return result.toObject();
    }

    //private findNthIndex(str: string, subStr: string, n: number) {
    //    var index = -1;
    //    for (; n > 0; n--) {
    //        index = str.indexOf(subStr, index + 1);
    //        if (n == 1 || index == -1) {
    //            return index;
    //        }
    //    }
    //}
}