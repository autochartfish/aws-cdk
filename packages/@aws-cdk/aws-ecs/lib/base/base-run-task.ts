import ec2 = require('@aws-cdk/aws-ec2');
import iam = require('@aws-cdk/aws-iam');
import stepfunctions = require('@aws-cdk/aws-stepfunctions');
import cdk = require('@aws-cdk/cdk');
import { ICluster } from '../cluster';
import { TaskDefinition } from './task-definition';

/**
 * Properties for SendMessageTask
 */
export interface BaseRunTaskProps extends stepfunctions.BasicTaskProps {
  /**
   * The topic to run the task on
   */
  cluster: ICluster;

  /**
   * Task Definition used for running tasks in the service
   */
  taskDefinition: TaskDefinition;

  /**
   * Container setting overrides
   *
   * Key is the name of the container to override, value is the
   * values you want to override.
   */
  containerOverrides?: ContainerOverride[];

  /**
   * Whether to wait for the task to complete and return the response
   *
   * @default true
   */
  synchronous?: boolean;
}

export interface ContainerOverride {
  /**
   * Name of the container inside the task definition
   *
   * Exactly one of `containerName` and `containerNamePath` is required.
   */
  containerName?: string;

  /**
   * JSONPath expression for the name of the container inside the task definition
   *
   * Exactly one of `containerName` and `containerNamePath` is required.
   */
  containerNamePath?: string;

  /**
   * Command to run inside the container
   *
   * @default Default command
   */
  command?: string[];

  /**
   * JSON expression for command to run inside the container
   *
   * @default Default command
   */
  commandPath?: string;

  /**
   * Variables to set in the container's environment
   */
  environment?: TaskEnvironmentVariable[];

  /**
   * The number of cpu units reserved for the container
   *
   * @Default The default value from the task definition.
   */
  cpu?: number;

  /**
   * JSON expression for the number of CPU units
   *
   * @Default The default value from the task definition.
   */
  cpuPath?: string;

  /**
   * Hard memory limit on the container
   *
   * @Default The default value from the task definition.
   */
  memoryLimit?: number;

  /**
   * JSON expression path for the hard memory limit
   *
   * @Default The default value from the task definition.
   */
  memoryLimitPath?: string;

  /**
   * Soft memory limit on the container
   *
   * @Default The default value from the task definition.
   */
  memoryReservation?: number;

  /**
   * JSONExpr path for memory limit on the container
   *
   * @Default The default value from the task definition.
   */
  memoryReservationPath?: number;
}

/**
 * An environment variable to be set in the container run as a task
 */
export interface TaskEnvironmentVariable {
  /**
   * Name for the environment variable
   *
   * Exactly one of `name` and `namePath` must be specified.
   */
  name?: string;

  /**
   * JSONExpr for the name of the variable
   *
   * Exactly one of `name` and `namePath` must be specified.
   */
  namePath?: string;

  /**
   * Value of the environment variable
   *
   * Exactly one of `value` and `valuePath` must be specified.
   */
  value?: string;

  /**
   * JSONPath expr for the environment variable
   *
   * Exactly one of `value` and `valuePath` must be specified.
   */
  valuePath?: string;
}

/**
 * A StepFunctions Task to run a Task on ECS or Fargate
 */
export class BaseRunTask extends stepfunctions.Task implements ec2.IConnectable {
  /**
   * Manage allowed network traffic for this service
   */
  public readonly connections: ec2.Connections = new ec2.Connections();

  protected networkConfiguration?: any;
  protected readonly _parameters: {[key: string]: any} = {};

  constructor(scope: cdk.Construct, id: string, props: BaseRunTaskProps) {
    super(scope, id, {
      ...props,
      resource: new RunTaskResource(props),
      parameters: new cdk.Token(() => ({
        Cluster: props.cluster.clusterArn,
        TaskDefinition: props.taskDefinition.taskDefinitionArn,
        NetworkConfiguration: this.networkConfiguration,
        ...this._parameters
      }))
    });

    this._parameters.Overrides = this.renderOverrides(props.containerOverrides);
  }

  protected configureAwsVpcNetworking(
      vpc: ec2.IVpcNetwork,
      assignPublicIp?: boolean,
      vpcPlacement?: ec2.VpcPlacementStrategy,
      securityGroup?: ec2.ISecurityGroup) {
    if (vpcPlacement === undefined) {
      vpcPlacement = { subnetsToUse: assignPublicIp ? ec2.SubnetType.Public : ec2.SubnetType.Private };
    }
    if (securityGroup === undefined) {
      securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', { vpc });
    }
    const subnets = vpc.subnets(vpcPlacement);
    this.connections.addSecurityGroup(securityGroup);

    this.networkConfiguration = {
      AwsvpcConfiguration: {
        AssignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
        Subnets: subnets.map(x => x.subnetId),
        SecurityGroups: new cdk.Token(() => [securityGroup!.securityGroupId]),
      }
    };
  }

  private renderOverrides(containerOverrides?: ContainerOverride[]) {
    if (!containerOverrides) { return undefined; }

    const ret = new Array<any>();
    for (const override of containerOverrides) {
      ret.push({
        ...extractRequired(override, 'containerName', 'Name'),
        ...extractOptional(override, 'command', 'Command'),
        ...extractOptional(override, 'cpu', 'Cpu'),
        ...extractOptional(override, 'memoryLimit', 'Memory'),
        ...extractOptional(override, 'memoryReservation', 'MemoryReservation'),
        Environment: override.environment && override.environment.map(e => ({
          ...extractRequired(e, 'name', 'Name'),
          ...extractRequired(e, 'value', 'Value'),
        }))
      });
    }

    return { ContainerOverrides: ret };
  }
}

class RunTaskResource implements stepfunctions.IStepFunctionsTaskResource {
  constructor(private readonly props: BaseRunTaskProps) {
  }

  public asStepFunctionsTaskResource(callingTask: stepfunctions.Task): stepfunctions.StepFunctionsTaskResourceProps {
    const stack = cdk.Stack.find(callingTask);
    const sync = this.props.synchronous !== false;

    // https://docs.aws.amazon.com/step-functions/latest/dg/ecs-iam.html
    const policyStatements = [
      new iam.PolicyStatement()
        .addAction('ecs:RunTask')
        .addResource(this.props.taskDefinition.taskDefinitionArn),
      new iam.PolicyStatement()
        .addActions('ecs:StopTask', 'ecs:DescribeTasks')
        .addAllResources(),
      new iam.PolicyStatement()
        .addAction('iam:PassRole')
        .addResources(...new cdk.Token(() => this.taskExecutionRoles().map(r => r.roleArn)).toList())
    ];

    if (sync) {
      policyStatements.push(new iam.PolicyStatement()
        .addActions("events:PutTargets", "events:PutRule", "events:DescribeRule")
        .addResource(stack.formatArn({
          service: 'events',
          resource: 'rule',
          resourceName: 'StepFunctionsGetEventsForECSTaskRule'
        })));
    }

    return {
      resourceArn: 'arn:aws:states:::ecs:runTask' + (sync ? '.sync' : ''),
      policyStatements,
    };
  }

  private taskExecutionRoles(): iam.IRole[] {
    // Need to be able to pass both Task and Execution role, apparently
    const ret = new Array<iam.IRole>();
    ret.push(this.props.taskDefinition.taskRole);
    if ((this.props.taskDefinition as any).executionRole) {
      ret.push((this.props.taskDefinition as any).executionRole);
    }
    return ret;
  }
}

function extractRequired(obj: any, srcKey: string, dstKey: string) {
    if ((obj[srcKey] !== undefined) === (obj[srcKey + 'Path'] !== undefined)) {
      throw new Error(`Supply exactly one of '${srcKey}' or '${srcKey}Path'`);
    }
    return mapValue(obj, srcKey, dstKey);
}

function extractOptional(obj: any, srcKey: string, dstKey: string) {
    if ((obj[srcKey] !== undefined) && (obj[srcKey + 'Path'] !== undefined)) {
      throw new Error(`Supply only one of '${srcKey}' or '${srcKey}Path'`);
    }
    return mapValue(obj, srcKey, dstKey);
}

function mapValue(obj: any, srcKey: string, dstKey: string) {
  if (obj[srcKey + 'Path'] !== undefined && !obj[srcKey + 'Path'].startsWith('$.')) {
    throw new Error(`Value for '${srcKey}Path' must start with '$.', got: '${obj[srcKey + 'Path']}'`);
  }

  return {
    [dstKey]: obj[srcKey],
    [dstKey + '.$']: obj[srcKey + 'Path']
  };
}