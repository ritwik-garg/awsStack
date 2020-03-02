import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import ec2 = require('@aws-cdk/aws-ec2');
import iam = require('@aws-cdk/aws-iam');
import batch = require('@aws-cdk/aws-batch');
import ecs = require('@aws-cdk/aws-ecs');

import {
    BrazilContainerImage,
    DeploymentStack,
    SoftwareType,
    DogmaTagsOptions,
    LambdaAsset,
    BrazilPackage,
}from '@amzn/pipelines';
import {DeploymentEnvironment} from '@amzn/builder-tools-scaffolding';
import {Runtime}from "@aws-cdk/aws-lambda";
import {Vpc, SubnetType}from "@aws-cdk/aws-ec2";
import {Duration} from '@aws-cdk/core';


export interface VendorFeedProcessorStackProps {
    readonly env: DeploymentEnvironment;
    readonly stackName ? : string;
    readonly stage: string;
    readonly domain: string;
    readonly realm: string;
    /**
    * Optional Dogma tags. Read `DogmaTags` for mode details or
    * this wiki https://w.amazon.com/bin/view/ReleaseExcellence/Team/Designs/PDGTargetSupport/Tags/
    */
    readonly dogmaTags ? : DogmaTagsOptions;
    /**
    * Stack tags that will be applied to all the taggable resources and the stack itself.
    *
    * @default {}
    */
    readonly tags ? : {
        [key: string]: string;
    };
}

export class VendorFeedProcessorStack extends DeploymentStack {
    private readonly lambda: lambda.Function;
    private readonly vpc: ec2.IVpc;
    private readonly batchComputeEnvironment: batch.CfnComputeEnvironment;
    private readonly batchJobDefinition: batch.CfnJobDefinition;
    private readonly batchJobQueue: batch.CfnJobQueue;
    private readonly batchJobQueueName: string = "VendorFeedProcessorJobQueue"

    constructor(parent: cdk.App, name: string, props: VendorFeedProcessorStackProps) {
        super(parent, name, {
            softwareType: SoftwareType.INFRASTRUCTURE,
            dogmaTags: props.dogmaTags,
            env: props.env,
            stackName: props.stackName,
            tags: props.tags,
        });

        // Import from BONES VPC
        this.vpc = ec2.Vpc.fromVpcAttributes(this, "VPCStack VPC", 
            {
                vpcId: cdk.Fn.importValue("VPC"),
                availabilityZones: this.availabilityZones
            });

        const privateSubnet1 = ec2.PrivateSubnet.fromPrivateSubnetAttributes(this, 'PrivateSubnet1', {
            availabilityZone: cdk.Fn.importValue("PrivateSubnet01AZ"),
            routeTableId: cdk.Fn.importValue("PrivateRouteTable1"),
            subnetId: cdk.Fn.importValue("PrivateSubnet01"),
        });

        const privateSubnet2 = ec2.PrivateSubnet.fromPrivateSubnetAttributes(this, 'PrivateSubnet2', {
            availabilityZone: cdk.Fn.importValue("PrivateSubnet02AZ"),
            routeTableId: cdk.Fn.importValue("PrivateRouteTable2"),
            subnetId: cdk.Fn.importValue("PrivateSubnet02"),
        });


        const batchServiceRole = new iam.Role(this, 'VFPBatchServiceRole', {
            assumedBy: new iam.ServicePrincipal('batch.amazonaws.com'),
            roleName: "VendorFeedProcessorBatchServiceRole",
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AWSBatchServiceRole')],
        });

        const batchInstanceRole = new iam.Role(this, 'VFPBatchInstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            roleName: "VendorFeedProcessorBatchInstanceRole",
            managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AmazonEC2ContainerServiceforEC2Role'),
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AmazonEC2RoleforSSM')
            ]
        });

        const batchInstanceProfile = new iam.CfnInstanceProfile(this, 'VFPBatchInstanceProfile', {
            roles: [batchInstanceRole.roleName]
        });

        const subnetIds = [privateSubnet1.subnetId, privateSubnet2.subnetId]
        const securityGroup = new ec2.SecurityGroup(this, 'VFPBatchSecurityGroup', {
            vpc: this.vpc
        });

        this.batchComputeEnvironment = new batch.CfnComputeEnvironment(
            this, 'VFPBatchComputeEnvironment', {
                serviceRole: batchServiceRole.roleArn,
                type: 'MANAGED',
                computeResources: {
                    instanceRole: batchInstanceProfile.ref,
                    instanceTypes: ['optimal'],
                    maxvCpus: 8,
                    minvCpus: 1,
                    desiredvCpus: 0,
                    subnets: subnetIds,
                    type: 'EC2',
                    securityGroupIds: [securityGroup.securityGroupId]
                },
                computeEnvironmentName: 'VendorFeedProcessorBatchComputeEnvironment'
            });

        const brazilContainerImage = BrazilContainerImage.fromBrazil({
            brazilPackage: BrazilPackage.fromString('EPIVendorFeedProcessorBatchJob-1.0'),
            transformPackage: BrazilPackage.fromString('EPIVendorFeedProcessorContainerImageBuilder-1.0'),
            componentName: 'VFPBatchJobComponent'
        });

        const taskDefinition = new ecs.TaskDefinition(this, 'VFPTaskDefinition', {
            compatibility: ecs.Compatibility.EC2
        });

        const containerDefinition = new ecs.ContainerDefinition(this,
            'VFPContainerDefinition', {
                image: brazilContainerImage,
                taskDefinition: taskDefinition,
                memoryLimitMiB: 2048,
            });

        const batchJobRole = new iam.Role(this, 'VFPBatchJobRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            roleName: "VendorFeedProcessorBatchJobRole",
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSESFullAccess'),
            iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess')]
        });

        const brazilContainerImageConfig = brazilContainerImage.bind(
            this, containerDefinition);

        this.batchJobDefinition = new batch.CfnJobDefinition(
            this, 'VFPBatchJobDefinition', {
                type: 'container',
                containerProperties: {
                    jobRoleArn: batchJobRole.roleArn,
                    image: brazilContainerImageConfig.imageName ,
                    vcpus: 1,
                    memory: 512,
                    environment: [
                    {
                        name: 'AWSRegion',
                        value: this.region
                    },
                    {
                        name: 'REALM',
                        value: props.realm
                    },
                    {
                        name: 'DOMAIN',
                        value: props.domain
                    }],
                    command: ["--inputBucket", "Ref::inputBucket", "--objectKey", "Ref::objectKey"]
                },
            });

        this.batchJobQueue = new batch.CfnJobQueue(this, this.batchJobQueueName, {
            jobQueueName: this.batchJobQueueName,
            computeEnvironmentOrder: [{
                computeEnvironment: this.batchComputeEnvironment.ref,
                order: 1,
            }],
            priority: 1,
            state: 'ENABLED'
        });

        const lamnbdRole = new iam.Role(this, "VFPInvokerLambdaRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
            roleName: "VendorFeedProcessorInvokerLambdaRole",
            managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
            iam.ManagedPolicy.fromAwsManagedPolicyName("AWSBatchFullAccess")
            ]
        });

        const lambdaExtendedPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['cloudwatch:*','logs:*','ec2:*'],
            resources: ["*"]
        });

        lamnbdRole.addToPolicy(lambdaExtendedPolicy);

        this.lambda = new lambda.Function(this, 'VFPInvokerLambda', {
            code: LambdaAsset.fromBrazil({
                brazilPackage: BrazilPackage.fromString('EPIVendorFeedProcessorInvokerLambda-1.0'),
                componentName: "VFPInvokerLambda"
            }),

            handler: 'com.amazon.epivendorfeedprocessor.invoker.config.VendorFeedProcessorInvoker::handleRequest',
            environment: {
                'Stage': props.stage,
                'Domain': props.domain,
                'Realm': props.realm,
                'BatchJobQueueName': this.batchJobQueueName,
                'BatchJobDefinitionArn': this.batchJobDefinition.ref
            },
            runtime: Runtime.JAVA_8,
            functionName: "EPIVendorFeedProcessorInvokerLambda",
            role: lamnbdRole,
            vpc: this.vpc,
            vpcSubnets: {
                subnets: [privateSubnet1, privateSubnet2]},
            securityGroup: securityGroup,
            timeout: Duration.seconds(30), // High duration in case we are returning a large file.
            memorySize: 256 // High memory for faster CPU and also in case we are returning a large file.

        });

        //Allow S3 to invoke this lambda
        this.lambda.grantInvoke(new iam.ServicePrincipal("s3.amazonaws.com"))

        new cdk.CfnOutput(this, "EPIVendorFeedProcessorInvokerLambdaArn", {
            description: "ARN of EPIVendorFeedProcessorInvokerLambda Function",
            value: this.lambda.functionArn,
            exportName: "EPIVendorFeedProcessorInvokerLambdaArn",
        });
    }
}
